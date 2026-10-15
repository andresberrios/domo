import { marked, type Token, type Tokens } from 'marked'

/**
 * The pure half of talking to a coding agent: what a transcript means, and how
 * the agent's text becomes sentences a speech model can be handed one at a time.
 */

export type SpokenTurn =
  /** An end-of-turn phrase closed it; `text` is what was said before the phrase. */
  | { kind: 'send', text: string }
  /** Words, and no end phrase yet. Hands-free holds these for the next segment. */
  | { kind: 'partial', text: string }
  /** "Stop": be quiet, keep working. */
  | { kind: 'hush' }
  /** "Cancel": stop the agent's turn. */
  | { kind: 'cancel' }
  | { kind: 'empty' }

/**
 * The radio convention, and the plain one. A bare "over" counts only after
 * punctuation or on its own, because "let's start over" is a sentence and not
 * a sign-off; "message over", "over and out", "that's it", "that's all" and
 * "go ahead" count anywhere at the end.
 */
const END_PHRASE = /(?:(?<=[,.;:!?])\s*over|\bmessage\s+over|\bover\s+and\s+out|\bthat(?:'s| is)\s+(?:it|all|everything)|\bend\s+of\s+message|\bgo\s+ahead)[\s.!?]*$/i
const BARE_END = /^(?:(?:message\s+)?over|that(?:'s| is)\s+(?:it|all|everything)|end\s+of\s+message|go\s+ahead)[\s.!?]*$/i
const HUSH = /^(?:ok(?:ay)?[,.]?\s*)?(?:stop|stop talking|quiet|be quiet|hush|shush|shut up)[\s.!?]*$/i
const CANCEL = /^(?:ok(?:ay)?[,.]?\s*)?(?:cancel|cancel that|cancel the turn|stop working|stop the turn|abort|never ?mind)[\s.!?]*$/i

/**
 * A transcriber that writes no punctuation turns "fix it, over" into "fix it
 * over". `lenient` takes a trailing bare "over" as the sign-off anyway; it is
 * for the last segment after a pause, where "start over" is unlikely and a
 * missed sign-off means a turn that never sends.
 */
const LENIENT_END = /\bover[\s.!?]*$/i

export function parseSpokenTurn(text: string, options: { lenient?: boolean } = {}): SpokenTurn {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return { kind: 'empty' }
  if (HUSH.test(clean)) return { kind: 'hush' }
  if (CANCEL.test(clean)) return { kind: 'cancel' }
  if (BARE_END.test(clean)) return { kind: 'send', text: '' }
  const match = END_PHRASE.exec(clean) ?? (options.lenient ? LENIENT_END.exec(clean) : null)
  if (match) return { kind: 'send', text: clean.slice(0, match.index).trim().replace(/[,;:]$/, '') }
  return { kind: 'partial', text: clean }
}

/**
 * A spoken answer to a permission request that was read out, or null when the
 * words are something else and should reach the agent as a turn. Only a reply
 * that is nothing but the answer counts. A bare "yes" or "no" counts only when
 * the request is the bar's own agent's: that agent is blocked on it, so there
 * is no other question it could answer. For another agent's request the words
 * have to say "allow" or "deny".
 */
export type PermissionAnswer = 'allow' | 'always' | 'deny'

const ALWAYS = /^(?:ok(?:ay)?[,.]?\s*)?(?:always(?: allow)?|allow always|always allow it|allow it always)[\s.!?]*$/i
const ALLOW = /^(?:ok(?:ay)?[,.]?\s*)?(?:allow(?: it)?|approve(?: it)?|accept(?: it)?|grant(?: it)?)[\s.!?]*$/i
const DENY = /^(?:ok(?:ay)?[,.]?\s*)?(?:deny(?: it)?|reject(?: it)?|refuse(?: it)?|decline(?: it)?|don'?t allow(?: it)?)[\s.!?]*$/i
const YES = /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|do it|go for it|fine)(?:[,.]?\s*(?:please|do it|go ahead))?[\s.!?]*$/i
const NO = /^(?:no|nope|nah|don'?t|do not)(?:[,.]?\s*(?:thanks|thank you|don'?t))?[\s.!?]*$/i

export function parsePermissionAnswer(text: string, options: { bare?: boolean } = {}): PermissionAnswer | null {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (ALWAYS.test(clean)) return 'always'
  if (ALLOW.test(clean)) return 'allow'
  if (DENY.test(clean)) return 'deny'
  if (options.bare && YES.test(clean)) return 'allow'
  if (options.bare && NO.test(clean)) return 'deny'
  return null
}

/**
 * A permission request's title as it can be said: an MCP tool id
 * (`mcp__domo__notify_supervisor`) becomes "notify supervisor, from domo",
 * where the Markdown clean-up would otherwise eat its double underscores.
 */
export function speakableTitle(title: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(title.trim())
  const words = (text: string) => text.replace(/[_-]+/g, ' ').trim()
  return mcp ? `${words(mcp[2]!)}, from ${words(mcp[1]!)}` : title
}

/** Two pieces of one utterance, heard across a pause. */
export function joinUtterance(held: string, more: string): string {
  return [held.trim(), more.trim()].filter(Boolean).join(' ')
}

/**
 * Cut the text the agent has streamed so far into sentences that are safe to
 * speak now, leaving the unfinished tail behind.
 *
 * A boundary needs whitespace after the punctuation, so "3." at the very end
 * of the buffer waits to see whether "5" follows, and a list's "1." at the
 * start of a line is not a sentence. A fenced code block and a table are never
 * split: while one is open, everything from its start stays behind; a closed
 * code block is said as "A code block." and a finished table goes out whole,
 * for `plainForSpeech` to sum up.
 */
export function takeSentences(buffer: string): { sentences: string[], rest: string } {
  let text = buffer
    .replace(/```[\s\S]*?```/g, '\nA code block.\n')
    // A table that something other than a row has followed: one piece, kept on one line.
    .replace(/(^|\n)((?:[ \t]*\|.*\n)+)(?=[ \t]*(?:\n|[^|\s]))/g, (_, start, table: string) => `${start}${table.trim().replace(/\n/g, '\uE000')}\n`)
  let held = ''
  // An open fence, or table rows running to the end of what has come so far.
  const open = /```|(?<=^|\n)(?:[ \t]*\|[^\n]*(?:\n|$))+$/.exec(text)
  if (open) {
    held = text.slice(open.index)
    text = text.slice(0, open.index)
  }

  const sentences: string[] = []
  const boundary = /(?<!(?:^|\n)\s*\d{1,3})[.!?]["')\]]*\s+|\n+/
  for (;;) {
    const match = boundary.exec(text)
    if (!match) break
    const end = match.index + match[0].length
    const sentence = text.slice(0, end).trim()
    text = text.slice(end)
    if (sentence) sentences.push(sentence.replace(/\uE000/g, '\n'))
  }
  return { sentences, rest: text + held }
}

/**
 * The first clause of a sentence still being written, when it is long enough
 * to say on its own: the words up to a comma, semicolon, colon or dash, at
 * least four of them. Speaking it before the sentence is finished is what
 * makes an answer start almost as soon as the agent does.
 */
export function takeClause(buffer: string): { clause: string, rest: string } | null {
  if (buffer.includes('```')) return null
  const boundary = /[,;:\u2013\u2014]\s+/g
  for (let match = boundary.exec(buffer); match; match = boundary.exec(buffer)) {
    const clause = buffer.slice(0, match.index + 1).trim()
    if (clause.length < 20 || clause.split(/\s+/).length < 4) continue
    return { clause, rest: buffer.slice(match.index + match[0].length) }
  }
  return null
}

/**
 * What is left of Markdown once it is to be said rather than shown: the words,
 * parsed by `marked` (the transcript's own renderer), with each paragraph,
 * heading and list item ended as a sentence, so they are not read as one run-on
 * line. A code block or a table is said as what it is, and a bare URL as its
 * site. The agent is asked not to write Markdown for speech; this is for when
 * it forgets, and for typed turns that are read out anyway.
 */
export function plainForSpeech(text: string): string {
  return wordsOf(marked.lexer(text)).replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim()
}

/** A block's words, ending as a sentence unless they already do. */
function sentence(words: string): string {
  const trimmed = words.trim()
  return !trimmed || /[.!?,;:…]["')\]]*$/.test(trimmed) ? `${trimmed} ` : `${trimmed}. `
}

function wordsOf(tokens: Token[] = []): string {
  return tokens.map((token: any) => {
    switch (token.type) {
      case 'code': return 'A code block. '
      case 'table': return token.rows.length === 1 ? 'A table with 1 row. ' : `A table with ${token.rows.length} rows. `
      case 'heading': case 'paragraph': return sentence(wordsOf(token.tokens))
      case 'list': return token.items.map((item: Tokens.ListItem) => sentence(wordsOf(item.tokens))).join('')
      case 'link': return token.text === token.href ? hostOf(token.href) : wordsOf(token.tokens)
      case 'image': case 'html': case 'hr': case 'space': return ' '
      case 'br': return ' '
      case 'codespan': case 'escape': return decode(token.text)
      default: return token.tokens ? wordsOf(token.tokens) : decode(token.text ?? '')
    }
  }).join('')
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** `marked` hands some text over HTML-escaped. */
function decode(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}
