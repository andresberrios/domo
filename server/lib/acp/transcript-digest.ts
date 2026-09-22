import { listAgentEvents } from '../repo'

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

/** Condense the durable ACP event log into a bounded, speakable transcript. */
export async function transcriptDigest(
  agentSessionId: string,
  options: TranscriptDigestOptions = {}
): Promise<TranscriptDigestItem[]> {
  const requested = Number(options.limit ?? 20)
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 20
  const include = new Set(options.include ?? TRANSCRIPT_DIGEST_KINDS)
  const messageChars = Math.max(100, Math.min(20_000, Number(options.messageChars) || 600))
  const events = await listAgentEvents(agentSessionId, 0, 4000)
  const items: TranscriptDigestItem[] = []
  let assistant = ''
  let thought = ''

  const flushAssistant = () => {
    if (assistant.trim()) items.push({ kind: 'agent', text: summarise(assistant, messageChars) })
    assistant = ''
  }
  const flushThought = () => {
    if (thought.trim()) items.push({ kind: 'thought', text: summarise(thought, 600) })
    thought = ''
  }
  const flushText = () => {
    flushAssistant()
    flushThought()
  }

  for (const event of events) {
    switch (event.type) {
      case 'user_message': {
        flushText()
        const text = (event.payload?.content ?? [])
          .filter((block: any) => block?.type === 'text')
          .map((block: any) => block.text)
          .join(' ')
        items.push({ kind: 'user', text: summarise(text, Math.min(messageChars, 2000)) })
        break
      }
      case 'agent_message':
        flushThought()
        assistant += event.payload?.text ?? ''
        break
      case 'agent_message_chunk':
        flushThought()
        if (event.payload?.content?.type === 'text') assistant += event.payload.content.text
        break
      case 'agent_thought':
        flushAssistant()
        thought += event.payload?.text ?? ''
        break
      case 'agent_thought_chunk':
        flushAssistant()
        if (event.payload?.content?.type === 'text') thought += event.payload.content.text
        break
      case 'tool_call':
        flushText()
        items.push({
          kind: 'tool',
          text: summarise(`${event.payload?.title ?? 'tool'} (${event.payload?.status ?? 'pending'})`, 400)
        })
        break
      case 'plan':
      case 'plan_update':
        flushText()
        items.push({
          kind: 'plan',
          text: summarise((event.payload?.entries ?? event.payload?.content?.entries ?? event.payload?.content?.items ?? [])
            .map((entry: any) => `${entry.status}: ${entry.content}`)
            .join('; '), 600)
        })
        break
      case 'permission_request':
        flushText()
        items.push({
          kind: 'permission',
          text: summarise(event.payload?.toolCall?.title ?? 'permission requested', 300)
        })
        break
      case 'turn_end':
        flushText()
        items.push({ kind: 'status', text: `turn finished (${event.payload?.stopReason ?? 'end_turn'})` })
        break
      case 'error':
        flushText()
        items.push({ kind: 'error', text: summarise(event.payload?.message ?? 'error', 300) })
        break
    }
  }
  flushText()

  return items.filter(item => item.text && include.has(category(item))).slice(-limit)
}
