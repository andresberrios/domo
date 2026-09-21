import type { VoiceMessage } from '../../../shared/types'

/**
 * What a continuing conversation hands the model, and what it folds away.
 *
 * A Live socket is short-lived — `goAway` arrives every few minutes, the tools
 * change, Nitro restarts — but the conversation is not: it is the row and the
 * `voice_messages` behind it. Every connect therefore rebuilds the context from
 * the database, and this module decides what that context is:
 *
 *   - everything up to `summary_through_seq` is represented by the durable
 *     rolling summary on the session row, and
 *   - everything after it is replayed verbatim, newest-first until a budget
 *     runs out.
 *
 * The two halves meet exactly at `summary_through_seq`: no overlap, no hole.
 * That is the whole trick behind "seamless" — what the model is told is the
 * same shape after three turns and after three hundred, whether the socket
 * resumed or started from nothing.
 *
 * Everything here is pure. The I/O (loading, summarising, writing back) lives
 * in `./compaction.ts`, so the part that is easy to get wrong is the part that
 * is trivial to test.
 */

/** Per message, in the verbatim tail. A tool result is JSON and can be huge. */
export const MESSAGE_CHARS = 800
/** The whole verbatim tail. */
export const TAIL_BUDGET_CHARS = 8000
/** The stored summary, however long the summariser felt like being. */
export const SUMMARY_CHARS = 4000
/**
 * How much uncompacted tail is allowed before a fold is worth a model call.
 * Below this the tail fits the budget on its own and a summary would only add
 * a lossy copy of what the model can already read.
 */
export const COMPACT_AFTER_CHARS = 6000
/**
 * How much of the tail a fold always leaves alone. The most recent exchanges
 * are the ones the user is likely to refer to ("do that again", "the second
 * one"), and a paraphrase of those is worse than nothing.
 */
export const KEEP_VERBATIM_CHARS = 2500
/**
 * How far back the cut may be walked to land on the start of a turn. Folding a
 * question and leaving its answer behind reads as a non-sequitur in both
 * halves, so the tail prefers to begin at something the user said.
 */
export const TURN_ALIGN_LOOKBACK = 8

/** Length only: the summary is a small document and its line breaks are meaning. */
function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim()
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, maxChars)}… (+${trimmed.length - maxChars} more characters)`
}

/** Length *and* shape: one message has to become one line. */
function clip(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars)}… (+${trimmed.length - maxChars} more characters)`
}

/**
 * One message as one line of context.
 *
 * Tool rows keep their name — which tool ran matters even when its output is
 * clipped to nothing — and system rows are labelled as Domo's own notices so
 * the model does not read them back as something the user said.
 */
export function renderMessage(message: VoiceMessage, maxChars = MESSAGE_CHARS): string {
  if (message.role === 'tool') {
    return `tool ${message.toolName ?? 'unknown'} → ${clip(message.text, Math.min(maxChars, 300))}`
  }
  if (message.role === 'system') return `note: ${clip(message.text, maxChars)}`
  return `${message.role}: ${clip(message.text, maxChars)}`
}

export interface ConversationContext {
  /** The block appended to the system instruction; empty for a fresh conversation. */
  text: string
  /** The messages replayed verbatim, oldest first. */
  verbatim: VoiceMessage[]
  /**
   * Uncompacted messages that fitted neither the summary nor the budget. Always
   * 0 while compaction is keeping up; above 0 it means something was genuinely
   * lost (a failed summariser, a tail that grew faster than the fold), and the
   * model is told so rather than left to infer it.
   */
  dropped: number
  /** Whether a durable summary stands in for the start of the conversation. */
  summarised: boolean
}

/**
 * Build the "this conversation is already under way" block for a connect.
 *
 * `messages` is the newest slice of the log, oldest first; anything already
 * covered by the summary is ignored, and the rest is taken from the end until
 * the budget runs out. The newest message is always kept, clipped if it has to
 * be: a turn the model cannot see at all is worse than one it sees the top of.
 */
export function buildConversationContext(input: {
  summary?: string | null
  summaryThroughSeq?: number | null
  messages: VoiceMessage[]
  /**
   * How many messages the summary does not cover *in the database*, when
   * `messages` is only a window onto the end of the log. Without it a backlog
   * older than the window would be invisible here and reported as nothing
   * lost, which is the one thing this block must never do.
   */
  uncoveredTotal?: number
  tailBudget?: number
  messageChars?: number
}): ConversationContext {
  const budget = input.tailBudget ?? TAIL_BUDGET_CHARS
  const messageChars = input.messageChars ?? MESSAGE_CHARS
  const summary = input.summary?.trim() || ''
  const through = input.summaryThroughSeq ?? 0

  const uncovered = input.messages.filter(message => message.seq > through)

  const verbatim: VoiceMessage[] = []
  let used = 0
  for (let i = uncovered.length - 1; i >= 0; i--) {
    const line = renderMessage(uncovered[i]!, messageChars)
    if (verbatim.length && used + line.length > budget) break
    used += line.length + 1
    verbatim.unshift(uncovered[i]!)
  }

  const dropped = Math.max(input.uncoveredTotal ?? uncovered.length, uncovered.length) - verbatim.length
  if (!summary && !verbatim.length) {
    return { text: '', verbatim: [], dropped: 0, summarised: false }
  }

  const parts: string[] = [
    'This conversation is already under way. Carry on from where it left off:'
    + ' no greeting, no reintroducing yourself, no asking the user to repeat'
    + ' what they have already told you.'
  ]
  if (summary) {
    parts.push('', 'Summary of the conversation so far:', truncate(summary, SUMMARY_CHARS))
  }
  if (dropped > 0) {
    const plural = dropped === 1 ? 'message' : 'messages'
    parts.push(
      '',
      `(${dropped} ${plural} ${summary ? 'between the summary and the lines below' : 'before the lines below'}`
      + ' could not be kept. Say so plainly if the user refers to something you cannot find.)'
    )
  }
  if (verbatim.length) {
    parts.push(
      '',
      'The most recent messages, oldest first:',
      ...verbatim.map(message => renderMessage(message, messageChars))
    )
  }

  return { text: parts.join('\n'), verbatim, dropped, summarised: !!summary }
}

export interface CompactionSlice {
  /** The messages to fold into the summary, oldest first. */
  messages: VoiceMessage[]
  /** The summary that results covers everything up to and including this seq. */
  throughSeq: number
  /** Rendered size of the tail that prompted the fold, for logging. */
  tailChars: number
}

/**
 * Which messages are ready to be folded into the summary, if any.
 *
 * Returns null when the tail is still small enough to send verbatim — the
 * common case, and the reason this is cheap enough to ask after every turn.
 */
export function selectCompactionSlice(input: {
  /** The log, oldest first. Anything at or below `summaryThroughSeq` is ignored. */
  messages: VoiceMessage[]
  summaryThroughSeq?: number | null
  triggerChars?: number
  keepChars?: number
  messageChars?: number
}): CompactionSlice | null {
  const trigger = input.triggerChars ?? COMPACT_AFTER_CHARS
  const keep = input.keepChars ?? KEEP_VERBATIM_CHARS
  const messageChars = input.messageChars ?? MESSAGE_CHARS
  const through = input.summaryThroughSeq ?? 0

  const uncovered = input.messages.filter(message => message.seq > through)
  if (uncovered.length < 2) return null

  const lines = uncovered.map(message => renderMessage(message, messageChars).length + 1)
  const tailChars = lines.reduce((total, length) => total + length, 0)
  if (tailChars < trigger) return null

  // Walk back from the newest message until enough of the tail is spoken for;
  // everything older than that is what gets folded.
  let cut = uncovered.length
  let kept = 0
  while (cut > 1 && kept < keep) {
    cut -= 1
    kept += lines[cut]!
  }

  // Prefer to start the tail at something the user said, so a question and its
  // answer stay on the same side of the cut.
  for (let i = cut, steps = 0; i > 0 && steps < TURN_ALIGN_LOOKBACK; i--, steps++) {
    if (uncovered[i]!.role === 'user') {
      cut = i
      break
    }
  }

  const slice = uncovered.slice(0, cut)
  if (!slice.length) return null
  return { messages: slice, throughSeq: slice[slice.length - 1]!.seq, tailChars }
}

/** The slice as the summariser sees it: one line per message, oldest first. */
export function renderTranscript(messages: VoiceMessage[], messageChars = MESSAGE_CHARS): string {
  return messages.map(message => renderMessage(message, messageChars)).join('\n')
}
