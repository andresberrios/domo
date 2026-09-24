import { listAgentEventsWindow } from '../repo'
import type { AgentEvent } from '../../../shared/types'

export const TRANSCRIPT_DIGEST_KINDS = ['messages', 'thoughts', 'tools', 'plan', 'notices'] as const
export type TranscriptDigestKind = typeof TRANSCRIPT_DIGEST_KINDS[number]

export interface TranscriptDigestOptions {
  limit?: number
  include?: TranscriptDigestKind[]
  /**
   * How much of a user or agent message to keep. The voice agent reads the
   * digest out loud, so its default is a sentence or two; a coding agent
   * reviewing a peer's report needs the report, and passes something larger.
   */
  messageChars?: number
}

export interface TranscriptDigestItem {
  kind: 'user' | 'agent' | 'thought' | 'tool' | 'plan' | 'permission' | 'status' | 'error'
  text: string
}

/** An item with the `seq` of the event it starts at, which is what a page cursor is. */
export type TranscriptPageItem = TranscriptDigestItem & { seq: number }

export interface TranscriptPage {
  items: TranscriptPageItem[]
  /** Pass as `beforeSeq` for the page before this one. Absent at the start of the log. */
  olderBeforeSeq?: number
  /** Pass as `afterSeq` for the page after this one. Absent at the end of the log. */
  newerAfterSeq?: number
}

/**
 * The event types the digest reads. Everything else — tool call updates, usage,
 * command lists — is most of a long log and says nothing a reader wants, so it
 * is never fetched at all.
 */
const DIGEST_EVENT_TYPES = [
  'user_message', 'agent_message', 'agent_message_chunk', 'agent_thought', 'agent_thought_chunk',
  'tool_call', 'plan', 'plan_update', 'permission_request', 'turn_end', 'error'
]
const BATCH = 500
/** How far one page will read looking for items that match `include`. */
const MAX_BATCHES = 40

function summarise(text: string | null, max: number): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

function category(item: TranscriptDigestItem): TranscriptDigestKind {
  if (item.kind === 'user' || item.kind === 'agent') return 'messages'
  if (item.kind === 'thought') return 'thoughts'
  if (item.kind === 'tool') return 'tools'
  if (item.kind === 'plan') return 'plan'
  return 'notices'
}

/** Fold events, oldest first, into items. Consecutive text blocks are one item. */
function fold(events: AgentEvent[], messageChars: number): TranscriptPageItem[] {
  const items: TranscriptPageItem[] = []
  let assistant = ''
  let assistantSeq = 0
  let thought = ''
  let thoughtSeq = 0

  const flushAssistant = () => {
    if (assistant.trim()) items.push({ seq: assistantSeq, kind: 'agent', text: summarise(assistant, messageChars) })
    assistant = ''
  }
  const flushThought = () => {
    if (thought.trim()) items.push({ seq: thoughtSeq, kind: 'thought', text: summarise(thought, 600) })
    thought = ''
  }
  const flushText = () => {
    flushAssistant()
    flushThought()
  }
  const addAssistant = (seq: number, text: string) => {
    if (!assistant) assistantSeq = seq
    assistant += text
  }
  const addThought = (seq: number, text: string) => {
    if (!thought) thoughtSeq = seq
    thought += text
  }

  for (const event of events) {
    const seq = event.seq
    switch (event.type) {
      case 'user_message': {
        flushText()
        const text = (event.payload?.content ?? [])
          .filter((block: any) => block?.type === 'text')
          .map((block: any) => block.text)
          .join(' ')
        items.push({ seq, kind: 'user', text: summarise(text, Math.min(messageChars, 2000)) })
        break
      }
      case 'agent_message':
        flushThought()
        addAssistant(seq, event.payload?.text ?? '')
        break
      case 'agent_message_chunk':
        flushThought()
        if (event.payload?.content?.type === 'text') addAssistant(seq, event.payload.content.text)
        break
      case 'agent_thought':
        flushAssistant()
        addThought(seq, event.payload?.text ?? '')
        break
      case 'agent_thought_chunk':
        flushAssistant()
        if (event.payload?.content?.type === 'text') addThought(seq, event.payload.content.text)
        break
      case 'tool_call':
        flushText()
        items.push({
          seq,
          kind: 'tool',
          text: summarise(`${event.payload?.title ?? 'tool'} (${event.payload?.status ?? 'pending'})`, 400)
        })
        break
      case 'plan':
      case 'plan_update':
        flushText()
        items.push({
          seq,
          kind: 'plan',
          text: summarise((event.payload?.entries ?? event.payload?.content?.entries ?? event.payload?.content?.items ?? [])
            .map((entry: any) => `${entry.status}: ${entry.content}`)
            .join('; '), 600)
        })
        break
      case 'permission_request':
        flushText()
        items.push({
          seq,
          kind: 'permission',
          text: summarise(event.payload?.toolCall?.title ?? 'permission requested', 300)
        })
        break
      case 'turn_end':
        flushText()
        items.push({ seq, kind: 'status', text: `turn finished (${event.payload?.stopReason ?? 'end_turn'})` })
        break
      case 'error':
        flushText()
        items.push({ seq, kind: 'error', text: summarise(event.payload?.message ?? 'error', 300) })
        break
    }
  }
  flushText()
  return items
}

/**
 * One page of the durable ACP event log, condensed into items.
 *
 * With neither cursor it is the newest page. `beforeSeq` pages back towards
 * the start and `afterSeq` forward towards the end, so a whole session of any
 * length can be read in either direction. Only the digest's own event types
 * are fetched, a batch at a time, until the page is full.
 *
 * The item at the far edge of what was fetched may be a text block cut in two
 * by the batch boundary, so unless the log really ends there it is left for
 * the next page, which reads it whole.
 */
export async function transcriptPage(
  agentSessionId: string,
  options: TranscriptDigestOptions & { beforeSeq?: number, afterSeq?: number } = {}
): Promise<TranscriptPage> {
  const requested = Number(options.limit ?? 20)
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 20
  const include = new Set(options.include ?? TRANSCRIPT_DIGEST_KINDS)
  const messageChars = Math.max(100, Math.min(20_000, Number(options.messageChars) || 600))
  const forwards = options.afterSeq !== undefined && options.afterSeq !== null
  const matches = (item: TranscriptPageItem) => item.text && include.has(category(item))

  const events: AgentEvent[] = []
  let cursor = forwards ? Number(options.afterSeq) : Number(options.beforeSeq ?? Number.MAX_SAFE_INTEGER)
  let exhausted: boolean
  let whole: TranscriptPageItem[] = []
  let edge: TranscriptPageItem | undefined
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await listAgentEventsWindow(agentSessionId, {
      types: DIGEST_EVENT_TYPES,
      limit: BATCH,
      ...forwards ? { afterSeq: cursor } : { beforeSeq: cursor }
    })
    exhausted = rows.length < BATCH
    if (forwards) events.push(...rows)
    else events.unshift(...rows.reverse())
    if (events.length) cursor = forwards ? events.at(-1)!.seq : events[0]!.seq

    const folded = fold(events, messageChars)
    edge = undefined
    if (!exhausted) edge = forwards ? folded.pop() : folded.shift()
    whole = folded
    if (exhausted || whole.filter(matches).length > limit) break
  }

  const filtered = whole.filter(matches)
  if (forwards) {
    const items = filtered.slice(0, limit)
    const next = filtered.length > limit ? filtered[limit]!.seq : edge?.seq
    return { items, ...next !== undefined ? { newerAfterSeq: next - 1 } : {} }
  }
  const items = filtered.slice(-limit)
  const older = filtered.length > limit ? items[0]!.seq : edge ? (whole[0]?.seq ?? cursor) : undefined
  return { items, ...older !== undefined ? { olderBeforeSeq: older } : {} }
}

/** The newest items of the log, for the voice agent. */
export async function transcriptDigest(
  agentSessionId: string,
  options: TranscriptDigestOptions = {}
): Promise<TranscriptDigestItem[]> {
  const page = await transcriptPage(agentSessionId, options)
  return page.items.map(({ kind, text }) => ({ kind, text }))
}
