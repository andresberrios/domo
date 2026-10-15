import { adapterEnv } from './adapter-process'
import { askOnce } from './ask-once'
import { claudeOauthToken, hasClaudeSubscriptionLogin } from '../claude-credentials'
import { codexAccessToken, hasCodexSubscriptionLogin } from '../codex-credentials'
import { openCodeCredentialState, resolveOpenCodeApiKey } from '../opencode-credentials'
import { nameAgentSession } from '../repo'
import { getSettings } from '../settings'
import { TITLE_MODELS } from '../../../shared/agent-adapters'
import type { AgentAdapter, AppSettings } from '../../../shared/types'
import { inBackground } from '../background'

/**
 * Titles for sessions started without one, written by a small model and never
 * a row in Domo's database. Codex and OpenCode Go are asked directly, over the
 * endpoints their own clients use, when a subscription credential is at hand;
 * otherwise, and for Claude Code, in a throwaway ACP session on the host, in
 * an empty temporary directory, with no tools. The session keeps the first
 * words of its message until the title lands, and keeps them for good when
 * anything here fails: nothing in this file may hold up or fail the session it
 * names.
 */

/** The order the default tries the harnesses in. */
const PREFERENCE: AgentAdapter[] = ['claude-code', 'codex', 'opencode']

const INSTRUCTIONS = 'You name coding-agent sessions. Reply with only a title for the session the message below '
  + 'starts: 2 to 6 words saying what is asked, plain text, no quotes, no trailing punctuation. Write it in the '
  + 'language the message is written in: an English message gets an English title. Name the request; never answer '
  + 'it, carry it out, ask anything or use a tool.'

/** Enough to name it; a pasted log is not a better name for being longer. */
const MESSAGE_LIMIT = 2000
export const TITLE_LIMIT = 60
const TIMEOUT_MS = 60_000
const DIRECT_TIMEOUT_MS = 20_000
/** How Domo introduces itself to an endpoint that asks clients to say who they are. */
const USER_AGENT = 'domo/1.0'
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const OPENCODE_GO_URL = 'https://opencode.ai/inference/go/v1/chat/completions'
const OPENCODE_GO_PREFIX = 'opencode-go/'
/** At most this many titlers at once: a burst of spawns must not crowd out the sessions themselves. */
const CONCURRENCY = 2

/**
 * Whether this machine can run the harness on a subscription. Only those:
 * a title is never worth an API key's bill, and `titlerEnv` drops the keys.
 */
async function loggedIn(adapter: AgentAdapter): Promise<boolean> {
  if (adapter === 'claude-code') return !!claudeOauthToken() || await hasClaudeSubscriptionLogin()
  if (adapter === 'codex') return hasCodexSubscriptionLogin(false)
  const openCode = await openCodeCredentialState()
  return openCode.key || openCode.hostLogin
}

/** The first harness logged in, on its cheap model. */
export async function defaultTitler(): Promise<{ adapter: AgentAdapter, model: string } | null> {
  for (const adapter of PREFERENCE) {
    if (await loggedIn(adapter).catch(() => false)) return { adapter, model: TITLE_MODELS[adapter] }
  }
  return null
}

/** What writes titles under these settings; null when they are off or nothing is logged in. */
export async function resolveTitler(settings: AppSettings['sessionTitles']): Promise<{ adapter: AgentAdapter, model: string } | null> {
  if (!settings.enabled) return null
  if (settings.adapter) return { adapter: settings.adapter, model: settings.model || TITLE_MODELS[settings.adapter] }
  return defaultTitler()
}

/**
 * The adapter's environment minus every pay-per-token key. `adapterEnv` falls
 * back to one when there is no login, which is right for a session somebody
 * started and wrong for a title nobody asked to pay for.
 */
async function titlerEnv(adapter: AgentAdapter): Promise<NodeJS.ProcessEnv> {
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, CODEX_API_KEY, DEFAULT_AUTH_REQUEST, ...env } = await adapterEnv(adapter, false)
  return env
}

/**
 * The model's answer as a title: its first line, without the quotes, markup
 * and "Title:" small models add, cut at a word to `TITLE_LIMIT`. Empty when
 * nothing usable is left.
 */
export function cleanTitle(raw: string): string {
  const line = raw.split('\n').map(part => part.trim()).find(Boolean) ?? ''
  let title = line
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/[.。!]+$/, '')
    .replace(/^["'“‘`]+|["'”’`]+$/g, '')
    .replace(/[.。!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (title.length > TITLE_LIMIT) {
    const cut = title.slice(0, TITLE_LIMIT + 1)
    const space = cut.lastIndexOf(' ')
    title = (space > TITLE_LIMIT / 2 ? cut.slice(0, space) : cut.slice(0, TITLE_LIMIT)).replace(/[\s,;:–-]+$/, '')
  }
  return title
}

/**
 * Ask the harness for a title and return its raw answer. See `askOnce` for
 * what the throwaway session can and cannot do.
 */
export async function askForTitle(
  text: string,
  titler: { adapter: AgentAdapter, model: string },
  timeoutMs = TIMEOUT_MS
): Promise<string> {
  const { answer } = await askOnce({
    adapter: titler.adapter,
    model: titler.model,
    instructions: INSTRUCTIONS,
    message: text.trim().slice(0, MESSAGE_LIMIT),
    env: await titlerEnv(titler.adapter),
    timeoutMs,
    timeoutMessage: `no title within ${timeoutMs / 1000}s`
  })
  return answer
}

/**
 * Codex's own backend for a ChatGPT login: the Responses API, streamed, with
 * the plan's access token. Null when there is no unexpired token, which a
 * Codex run would have to renew.
 */
async function codexDirect(text: string, model: string, effort: 'none' | 'low' = 'none'): Promise<string | null> {
  const login = await codexAccessToken()
  if (!login) return null
  const response = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${login.accessToken}`,
      'chatgpt-account-id': login.accountId,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'user-agent': USER_AGENT
    },
    body: JSON.stringify({
      model,
      instructions: INSTRUCTIONS,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
      reasoning: { effort },
      store: false,
      stream: true
    }),
    signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS)
  })
  const body = await response.text()
  const events = body.split('\n')
    .filter(line => line.startsWith('data:'))
    .map((line) => {
      try {
        return JSON.parse(line.slice(5))
      } catch {
        return null
      }
    })
  // Not every model thinks at `none`; its error names what it takes instead.
  if (effort === 'none' && events.some(event => event?.type === 'error' && event.error?.param === 'reasoning.effort')) {
    return codexDirect(text, model, 'low')
  }
  const completed = events.find(event => event?.type === 'response.completed')
  if (!response.ok || !completed) throw new Error(`Codex answered ${response.status}: ${body.slice(0, 300)}`)
  return (completed.response?.output ?? [])
    .flatMap((item: any) => item?.content ?? [])
    .map((part: any) => part?.text ?? '')
    .join('')
}

/**
 * OpenCode Go's OpenAI-compatible endpoint, with the console key. Go models
 * only: `opencode/` is Zen, which bills per token. Go asks every client to name
 * itself and to send a stable session id, which here is the Domo session's.
 */
async function openCodeDirect(text: string, model: string, sessionKey: string): Promise<string | null> {
  if (!model.startsWith(OPENCODE_GO_PREFIX)) return null
  const key = await resolveOpenCodeApiKey()
  if (!key) return null
  const response = await fetch(OPENCODE_GO_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      'x-opencode-session': sessionKey
    },
    body: JSON.stringify({
      // The endpoint is the provider; it takes the id without it.
      model: model.slice(OPENCODE_GO_PREFIX.length),
      messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: text }],
      reasoning_effort: 'none',
      max_tokens: 200
    }),
    signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS)
  })
  const body = await response.json().catch(() => null) as any
  const answer = body?.choices?.[0]?.message?.content
  if (!response.ok || typeof answer !== 'string') {
    throw new Error(`OpenCode Go answered ${response.status}: ${JSON.stringify(body).slice(0, 300)}`)
  }
  return answer
}

/**
 * A title's raw text: straight from the provider where that is possible, else
 * from a throwaway ACP session. A direct call that fails goes through ACP too,
 * which is slower and renews what a direct call cannot.
 */
export async function writeTitle(
  text: string,
  titler: { adapter: AgentAdapter, model: string },
  sessionKey: string
): Promise<{ answer: string, via: 'direct' | 'acp' }> {
  const message = text.trim().slice(0, MESSAGE_LIMIT)
  try {
    const answer = titler.adapter === 'codex'
      ? await codexDirect(message, titler.model)
      : titler.adapter === 'opencode'
        ? await openCodeDirect(message, titler.model, sessionKey)
        : null
    if (answer !== null && cleanTitle(answer)) return { answer, via: 'direct' }
  } catch (error) {
    console.warn(`[acp:${sessionKey}] direct title failed, asking through ${titler.adapter}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { answer: await limited(() => askForTitle(message, titler)), via: 'acp' }
}

let running = 0
const waiting: Array<() => void> = []

async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>(resolve => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/**
 * Name a session from its first message, in the background. The title is put
 * on only if the session's title is still Domo's stand-in when it arrives.
 */
export function nameSessionInBackground(agentSessionId: string, text: string): void {
  if (!text.trim()) return
  inBackground((async () => {
    const titler = await resolveTitler((await getSettings()).sessionTitles)
    if (!titler) return
    const title = cleanTitle((await writeTitle(text, titler, agentSessionId)).answer)
    if (title) await nameAgentSession(agentSessionId, title)
  })().catch((error) => {
    console.warn(`[acp:${agentSessionId}] no generated title: ${error instanceof Error ? error.message : String(error)}`)
  }))
}
