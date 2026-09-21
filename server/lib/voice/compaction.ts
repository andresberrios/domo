import { GoogleGenAI } from '@google/genai'

import { geminiApiKey } from '../gemini'
import { getVoiceSession, listVoiceMessagesAfter, saveConversationSummary } from '../repo'
import { SUMMARY_CHARS, renderTranscript, selectCompactionSlice } from './context'

/**
 * Folding the start of a conversation into a durable summary.
 *
 * The rule the rest of the system relies on: after a successful fold the
 * session row's `summary` covers *exactly* the messages up to
 * `summary_through_seq`, and `buildConversationContext` replays everything
 * after it verbatim. A fold never runs backwards (the write is guarded on the
 * seq it advances past), never overlaps, and never leaves a gap.
 *
 * The summariser is an injected parameter. The default one costs a Gemini text
 * call; every test passes its own, and nothing in the test suite may reach the
 * network.
 */

/** How many of the newest messages a fold or a connect will even look at. */
export const CONTEXT_MESSAGE_LIMIT = 200
/** A connect waits this long for a fold before going ahead without it. */
export const COMPACT_CONNECT_TIMEOUT_MS = 6000

/**
 * The text model that writes the summary. Not the Live model: it cannot do this.
 *
 * Lite by choice, and measured rather than assumed — see the AGENTS.md bullet.
 * A fold is a background job on a few kilobytes of transcript, and the connect
 * path waits on it, so latency is the property that matters.
 */
export function summaryModel(): string {
  return process.env.NUXT_GEMINI_SUMMARY_MODEL || process.env.GEMINI_SUMMARY_MODEL || 'gemini-flash-lite-latest'
}

export interface SummariseInput {
  /** The summary this one replaces, if the conversation has been folded before. */
  previous: string | null
  /** The messages being folded in, one per line, oldest first. */
  transcript: string
  title: string
}

export type Summariser = (input: SummariseInput) => Promise<string>

export type CompactionResult =
  | { compacted: true, throughSeq: number, summary: string, folded: number }
  | { compacted: false, reason: 'not-needed' | 'no-session' | 'superseded' | 'failed', error?: string }

const SUMMARISER_INSTRUCTION = `You maintain the running memory of a spoken conversation between a developer and
Domo, an assistant that runs coding agents for them. You are handed the memory
so far and the next stretch of transcript, and you return the memory that
replaces it. Your output is read by Domo at the start of its next session; the
user never sees it.

Rules:
- Write the whole memory, not a diff and not a note about what changed.
- Plain prose and short dashed lists. No headings the user would hear, no
  preamble, no "in this conversation".
- Keep what a colleague would need to pick the thread up: what the user is
  working on and why, decisions and preferences they stated, coding agents and
  dev environments involved, what each was asked to do and how it ended, open
  questions, and anything promised but not yet done.
- Keep identifiers exact — agent and session ids, branch, file and project
  names, error text. They are the things Domo cannot reconstruct.
- Drop chit-chat, acknowledgements, and tool output that changed nothing.
- Prefer the recent and the unresolved over the old and the settled, but never
  silently drop a commitment.
- Aim for under 300 words. Stay well under 500 even for a long conversation.`

/**
 * The default summariser: one Gemini text call.
 *
 * Exported so it can be exercised by hand against a real key — nothing in the
 * suite may reach the network, so this is the only way to find out that a model
 * id has stopped existing.
 */
export async function summariseWithGemini(input: SummariseInput): Promise<string> {
  const apiKey = geminiApiKey()
  if (!apiKey) throw new Error('No Gemini API key, so the conversation cannot be summarised')
  const ai = new GoogleGenAI({ apiKey })
  const prompt = [
    `Conversation title: ${input.title}`,
    '',
    input.previous
      ? `Memory so far:\n${input.previous}`
      : 'Memory so far: (none — this is the first fold of this conversation)',
    '',
    'Next stretch of transcript, oldest first:',
    input.transcript,
    '',
    'Return the updated memory.'
  ].join('\n')

  const response = await ai.models.generateContent({
    model: summaryModel(),
    contents: prompt,
    // No output cap: a thinking model can spend one entirely on thinking and
    // answer with empty text. The length is bounded on the way into the row.
    config: { temperature: 0.2, systemInstruction: SUMMARISER_INSTRUCTION }
  })

  const text = (response.text ?? '').trim()
  if (!text) throw new Error('The summariser returned nothing')
  return text
}

/**
 * Folds in flight, by session. Compaction is asked for after every turn and at
 * every connect, so the same fold would otherwise be paid for several times
 * over — and two writes racing would be two model calls to reach one row.
 */
const inFlight = new Map<string, Promise<CompactionResult>>()

/**
 * Fold this conversation's oldest uncompacted messages into its summary, if
 * there are enough of them to be worth a model call.
 *
 * Cheap and safe to call often: the common answer is `not-needed` after one
 * query. Never throws — a conversation that cannot be summarised carries on
 * with a verbatim tail, and `buildConversationContext` says what was lost.
 */
export function compactConversation(
  voiceSessionId: string,
  options: { summarise?: Summariser } = {}
): Promise<CompactionResult> {
  const existing = inFlight.get(voiceSessionId)
  if (existing) return existing
  const run = runCompaction(voiceSessionId, options).finally(() => {
    inFlight.delete(voiceSessionId)
  })
  inFlight.set(voiceSessionId, run)
  return run
}

async function runCompaction(
  voiceSessionId: string,
  options: { summarise?: Summariser }
): Promise<CompactionResult> {
  const session = await getVoiceSession(voiceSessionId)
  if (!session) return { compacted: false, reason: 'no-session' }

  // From the boundary forward, never "the newest N": a fold that skipped the
  // messages between the last summary and its window would advance
  // `summary_through_seq` past text nothing ever read. A backlog bigger than
  // the window is folded a chunk per turn instead.
  const messages = await listVoiceMessagesAfter(
    voiceSessionId,
    session.summaryThroughSeq ?? 0,
    CONTEXT_MESSAGE_LIMIT
  )
  const slice = selectCompactionSlice({ messages, summaryThroughSeq: session.summaryThroughSeq })
  if (!slice) return { compacted: false, reason: 'not-needed' }

  const summarise = options.summarise ?? summariseWithGemini
  let summary: string
  try {
    summary = await summarise({
      previous: session.summary,
      transcript: renderTranscript(slice.messages),
      title: session.title
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[voice:${voiceSessionId}] compaction failed: ${message}`)
    return { compacted: false, reason: 'failed', error: message }
  }

  summary = summary.trim().slice(0, SUMMARY_CHARS)
  if (!summary) return { compacted: false, reason: 'failed', error: 'empty summary' }

  const saved = await saveConversationSummary(voiceSessionId, {
    summary,
    throughSeq: slice.throughSeq
  })
  // Another fold got further while this one was with the model. Its summary
  // covers ours, so ours is simply dropped.
  if (!saved) return { compacted: false, reason: 'superseded' }

  console.info(
    `[voice:${voiceSessionId}] folded ${slice.messages.length} messages `
    + `(${slice.tailChars} chars of tail) into the summary, through seq ${slice.throughSeq}`
  )
  return { compacted: true, throughSeq: slice.throughSeq, summary, folded: slice.messages.length }
}

/**
 * Compact before a connect, but never hold one up for long.
 *
 * The fold matters most exactly here — a reconnect is where an uncompacted
 * middle would be dropped — but a conversation that cannot reach the
 * summariser must still get its socket. A timeout leaves the fold running; it
 * lands for the connect after this one.
 */
export async function ensureCompacted(
  voiceSessionId: string,
  options: { summarise?: Summariser, timeoutMs?: number } = {}
): Promise<CompactionResult> {
  const timeoutMs = options.timeoutMs ?? COMPACT_CONNECT_TIMEOUT_MS
  const compaction = compactConversation(voiceSessionId, options).catch((error): CompactionResult => ({
    compacted: false,
    reason: 'failed',
    error: error instanceof Error ? error.message : String(error)
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<CompactionResult>((resolve) => {
    timer = setTimeout(() => resolve({ compacted: false, reason: 'failed', error: 'timed out' }), timeoutMs)
    timer.unref?.()
  })
  return Promise.race([compaction, timeout]).finally(() => clearTimeout(timer))
}
