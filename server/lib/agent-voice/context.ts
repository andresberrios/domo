import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'
import { SPOKEN_NOTE_PREFIX } from '../../../shared/agent-voice'
import { getAgentSession, getDevEnvironment, getProject, listRecentConversation } from '../repo'

const run = promisify(execFile)

/**
 * What speech recognition is told before it hears a turn.
 *
 * A developer talking to a coding agent says words no general model expects:
 * `useAgentVoice`, Nuxt, Kokoro, pnpm. Heard cold, those come back as "use a
 * gent voice", "next", "cocoa row". Every engine that takes a prompt does far
 * better when it is told what was just said and which words exist, so each
 * turn is heard with two things: the last few messages of the conversation,
 * and a vocabulary drawn from that conversation and from the project's own
 * files. The device's recogniser takes the vocabulary as phrases. Engines
 * without a prompt hear cold: a fuzzy spelling pass against the vocabulary
 * afterwards was measured and made every engine worse.
 */
export interface SpeechContext {
  /** The last few messages, oldest first, as `Developer:` / `Agent:` lines. */
  conversation: string
  /** Terms likely to be said, most likely first. */
  vocabulary: string[]
}

export const EMPTY_SPEECH_CONTEXT: SpeechContext = { conversation: '', vocabulary: [] }

/** How much of the conversation goes into a prompt. Recognisers read the end of a prompt most. */
const CONVERSATION_CHARS = 900
const MESSAGE_CHARS = 320
const VOCABULARY_TERMS = 80
/** A project's files are read again after this long, not on every turn. */
const PROJECT_TTL_MS = 10 * 60_000

/**
 * Words that are capitalised or code-shaped in docs and conversations but are
 * ordinary English, so a recogniser needs no help with them.
 */
const COMMON = new Set(`a about above after again against all also am an and any are as at be because been before being below
between both but by can could did do does doing done down during each else even every few for from further had has have having
he her here hers him his how however i if in into is it its itself just let like make many may me might more most must my never
new no nor not now of off on once one only or other our out over own per same see she should since so some such than that the
their them then there these they this those through to too under until up us use used very was we were what when where which
while who whom why will with within without would yet you your yours
note read run set get add see try keep make take give find show tell say ask put call start stop open close check test build
first last next each other before after only never always often sometimes then once still already
yes okay ok sure right well good great fine thanks please sorry hello hi look maybe actually really cool done wait hey
true false null undefined none todo fixme api url id ids ui http https json html css js ts md sh yaml yml txt png svg
default example value values name names type types file files line lines code data error errors message messages
index src lib app test tests spec specs util utils helper helpers config main readme license changelog`.split(/\s+/))

function words(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*/g) ?? []
}

/** Whether a token is shaped like code or a name: camelCase, snake_case, kebab-case, a digit in a word. */
function looksLikeIdentifier(token: string): boolean {
  return /[a-z][A-Z]/.test(token)
    || /[A-Za-z][_-][A-Za-z0-9]/.test(token)
    || (/\d/.test(token) && /[A-Za-z]{2}/.test(token))
    || /^[A-Z]{2,5}s?$/.test(token)
}

function usable(term: string): boolean {
  if (term.length < 3 || term.length > 40) return false
  if (COMMON.has(term.toLowerCase())) return false
  // A hash, a uuid, a long number: nobody says those.
  if (/^[0-9a-f]{7,}$/i.test(term) || /\d{4,}/.test(term)) return false
  // An environment variable is typed, not said.
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+){2,}$/.test(term)) return false
  return true
}

/**
 * The terms in a piece of prose or Markdown worth telling a recogniser
 * about, each with how strongly it stood out: code spans and identifiers
 * count double, a capitalised word half as much when it starts a sentence.
 * A plain word also used lowercase in ordinary prose is English, not jargon,
 * and is dropped (`server`, "Settings"); one seen only in code is kept (`pnpm`).
 */
export function termsFromText(text: string): Map<string, number> {
  const scores = new Map<string, number>()
  const english = new Set<string>()
  const bump = (term: string, by: number) => {
    const clean = term.replace(/^[._-]+|[._-]+$/g, '')
    if (usable(clean)) scores.set(clean, (scores.get(clean) ?? 0) + by)
  }
  for (const match of text.matchAll(/`([^`\n]{2,60})`/g)) {
    for (const token of words(match[1]!)) bump(stem(token), 2)
  }
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ')
  for (const sentence of prose.split(/(?<=[.!?:;])\s+|\n+/)) {
    const tokens = words(sentence)
    tokens.forEach((token, index) => {
      if (looksLikeIdentifier(token)) bump(stem(token), 2)
      // A capital that starts a sentence is weaker evidence of a name than one inside it.
      else if (/^[A-Z][a-z]{2,}$/.test(token)) bump(token, index > 0 ? 1 : 0.5)
      else if (/^[a-z]+$/.test(token)) english.add(token)
    })
  }
  for (const term of scores.keys()) {
    if (/^[A-Za-z][a-z]+$/.test(term) && english.has(term.toLowerCase())) scores.delete(term)
  }
  return scores
}

/** `runtime.ts` is said "runtime"; `foo/bar.vue` is said "bar". */
function stem(token: string): string {
  const last = token.split('/').pop()!
  return /\.(?:[jt]sx?|vue|mjs|cjs|md|json|ya?ml|py|go|rs|sh|css)$/i.test(last) ? last.replace(/\.[^.]+$/, '') : last
}

/** The terms in a list of file paths: the names of components, composables, modules. */
export function termsFromPaths(paths: string[]): Map<string, number> {
  const scores = new Map<string, number>()
  for (const path of paths) {
    const name = basename(path, extname(path))
    for (const token of [name, ...path.split('/').slice(0, -1)]) {
      if (!looksLikeIdentifier(token) || !usable(token)) continue
      scores.set(token, (scores.get(token) ?? 0) + 1)
    }
  }
  return scores
}

function merge(into: Map<string, number>, from: Map<string, number>, weight = 1) {
  for (const [term, score] of from) into.set(term, (into.get(term) ?? 0) + score * weight)
}

/** Highest score first, one entry per spelling-insensitive term, in its most used spelling. */
function ranked(scores: Map<string, number>): string[] {
  const byKey = new Map<string, { term: string, best: number, total: number }>()
  for (const [term, score] of scores) {
    const key = term.toLowerCase()
    const entry = byKey.get(key)
    if (!entry) byKey.set(key, { term, best: score, total: score })
    else {
      entry.total += score
      if (score > entry.best || (score === entry.best && term !== key)) {
        entry.term = term
        entry.best = score
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.total - a.total).map(entry => entry.term)
}

/* ------------------------------ project ------------------------------ */

const DOC_NAMES = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']
const DOC_BYTES = 60_000
const projects = new Map<string, { at: number, terms: Promise<string[]> }>()

async function readSome(path: string): Promise<string> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return ''
    const text = await readFile(path, 'utf8')
    return text.slice(0, DOC_BYTES)
  } catch {
    return ''
  }
}

async function projectTerms(root: string): Promise<string[]> {
  const scores = new Map<string, number>()
  const docs = [...DOC_NAMES]
  try {
    for (const entry of await readdir(join(root, 'docs'))) {
      if (entry.endsWith('.md')) docs.push(join('docs', entry))
    }
  } catch {
    /* no docs folder */
  }
  // One text, so a word used as English in any doc counts as English in all.
  // AGENTS.md and CLAUDE.md are often the same file.
  const texts = new Set(await Promise.all(docs.slice(0, 24).map(doc => readSome(join(root, doc)))))
  merge(scores, termsFromText([...texts].join('\n\n')))

  try {
    const pkg = JSON.parse(await readSome(join(root, 'package.json')) || '{}')
    const deps = [pkg.name, ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })]
    for (const dep of deps) {
      if (typeof dep !== 'string') continue
      // `@nuxt/ui` is said "Nuxt UI"; the scope is noise.
      const name = dep.replace(/^@[^/]+\//, '')
      if (usable(name)) scores.set(name, (scores.get(name) ?? 0) + 1)
    }
  } catch {
    /* not a Node project */
  }

  try {
    const { stdout } = await run('git', ['ls-files'], { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 5000 })
    merge(scores, termsFromPaths(stdout.split('\n').filter(Boolean).slice(0, 20_000)))
  } catch {
    /* not a git checkout */
  }
  return ranked(scores)
}

/** A project's vocabulary, read once and kept for a while. */
export function projectVocabulary(root: string): Promise<string[]> {
  const cached = projects.get(root)
  if (cached && Date.now() - cached.at < PROJECT_TTL_MS) return cached.terms
  const terms = projectTerms(root).catch(() => [])
  projects.set(root, { at: Date.now(), terms })
  return terms
}

/** Where a session's files can be read from this process. An environment's session runs in a container. */
async function projectRoot(agentSessionId: string): Promise<string | null> {
  const session = await getAgentSession(agentSessionId)
  if (!session) return null
  if (!session.devEnvironmentId) return session.cwd
  const environment = await getDevEnvironment(session.devEnvironmentId)
  const project = environment ? await getProject(environment.projectId) : null
  return project?.repoPath ?? null
}

/* ---------------------------- conversation --------------------------- */

type Said = { type: 'user_message' | 'agent_message' | 'tool_call', text: string }

/** A user message minus the spoken-channel note, which is ours and not theirs. */
function withoutNote(text: string): string {
  const at = text.indexOf(SPOKEN_NOTE_PREFIX)
  return (at >= 0 ? text.slice(0, at) : text).trim()
}

/** The end of each message, oldest first, as a transcript a recogniser can read. */
export function conversationPrompt(recent: Said[]): string {
  const lines: string[] = []
  let budget = CONVERSATION_CHARS
  for (const item of recent) {
    if (item.type === 'tool_call') continue
    let text = (item.type === 'user_message' ? withoutNote(item.text) : item.text).replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (text.length > MESSAGE_CHARS) text = `…${text.slice(-MESSAGE_CHARS)}`
    const line = `${item.type === 'user_message' ? 'Developer' : 'Agent'}: ${text}`
    if (line.length > budget) break
    budget -= line.length
    lines.unshift(line)
  }
  return lines.join('\n')
}

/** A tool call's title: the files it touched by name, and any identifiers in the rest. */
function termsFromToolCall(title: string): Map<string, number> {
  const paths = title.split(/\s+/).filter(token => token.includes('/'))
  const scores = termsFromText(title.split(/\s+/).filter(token => !token.includes('/')).join(' '))
  merge(scores, termsFromPaths(paths), 2)
  return scores
}

/** Conversation terms first, the newest weighing most, then the project's. */
export function combineVocabulary(recent: Said[], project: string[], limit = VOCABULARY_TERMS): string[] {
  const scores = new Map<string, number>()
  recent.forEach((item, index) => {
    const text = item.type === 'user_message' ? withoutNote(item.text) : item.text
    merge(scores, item.type === 'tool_call' ? termsFromToolCall(text) : termsFromText(text), 1 / (1 + index * 0.25))
  })
  const out: string[] = []
  const seen = new Set<string>()
  for (const term of [...ranked(scores), ...project]) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= limit) break
  }
  return out
}

export async function speechContext(agentSessionId: string): Promise<SpeechContext> {
  const [recent, root] = await Promise.all([
    listRecentConversation(agentSessionId),
    projectRoot(agentSessionId)
  ])
  const project = root ? await projectVocabulary(root) : []
  return { conversation: conversationPrompt(recent), vocabulary: combineVocabulary(recent, project) }
}

/* ------------------------------ prompts ------------------------------ */

/**
 * The context as one prompt for a recogniser that reads instructions
 * (Gemini, OpenAI's transcribe models). The vocabulary is a spelling guide,
 * not a hint of what was said.
 */
export function instructionPrompt(context: SpeechContext): string {
  const parts: string[] = []
  if (context.vocabulary.length) {
    parts.push(`Terms from this software project, spelled as written: ${context.vocabulary.join(', ')}.`)
  }
  if (context.conversation) parts.push(`The conversation so far:\n${context.conversation}`)
  return parts.join('\n\n')
}

/**
 * The context as the text before the audio, for Whisper-style models that
 * continue a prompt rather than follow it. They weigh its last words most, so
 * the conversation goes last and the whole is kept short.
 */
export function precedingTextPrompt(context: SpeechContext, maxChars = 700): string {
  const glossary = context.vocabulary.length ? `Glossary: ${context.vocabulary.slice(0, 40).join(', ')}.` : ''
  const recent = context.conversation.split('\n').map(line => line.replace(/^(Developer|Agent): /, '')).join(' ')
  const room = Math.max(0, maxChars - glossary.length - 1)
  return [glossary, recent.length > room ? recent.slice(-room) : recent].filter(Boolean).join(' ')
}
