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

/** Two pieces of one utterance, heard across a pause. */
export function joinUtterance(held: string, more: string): string {
  return [held.trim(), more.trim()].filter(Boolean).join(' ')
}

/**
 * Cut the text the agent has streamed so far into sentences that are safe to
 * speak now, leaving the unfinished tail behind.
 *
 * A boundary needs whitespace after the punctuation, so "3." at the very end
 * of the buffer waits to see whether "5" follows. A fenced code block is never
 * split: while its fence is open, everything from the fence on stays behind,
 * and once it closes the block is dropped whole, because the agent was told not
 * to write code for speech and a block that slipped through is not something
 * to read out.
 */
export function takeSentences(buffer: string): { sentences: string[], rest: string } {
  let text = buffer.replace(/```[\s\S]*?```/g, ' ')
  let held = ''
  const open = text.indexOf('```')
  if (open >= 0) {
    held = text.slice(open)
    text = text.slice(0, open)
  }

  const sentences: string[] = []
  const boundary = /[.!?]["')\]]*\s+|\n+/
  for (;;) {
    const match = boundary.exec(text)
    if (!match) break
    const end = match.index + match[0].length
    const sentence = text.slice(0, end).trim()
    text = text.slice(end)
    if (sentence) sentences.push(sentence)
  }
  return { sentences, rest: text + held }
}

/**
 * What is left of a Markdown sentence once it is to be said rather than shown.
 * The agent is asked not to write Markdown for speech; this is for when it
 * forgets, and for typed turns that are read out anyway.
 */
export function plainForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)([^*_\n]+)\1/g, '$2')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
