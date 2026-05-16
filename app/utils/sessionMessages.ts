/**
 * Per-adapter, client-side projection: claude-code-cli durable events +
 * inbox prompts → AI SDK `UIMessage[]`.
 *
 * This is the adapter layer behind the design decision to standardize the
 * UI transcript on the AI SDK `UIMessage` shape (see initial-design.md):
 * the durable stream stays our rich *native* claude stream-json event log;
 * the UI only ever consumes `UIMessage[]`, so a future `ai`-package-based
 * agent can emit that shape natively and reuse the exact same renderer.
 *
 * Claude stream-json envelopes we fold in:
 *  - `assistant` → an assistant message; content blocks become parts:
 *      text → text part, thinking → reasoning part,
 *      tool_use → `dynamic-tool` part (state `input-available`)
 *  - `user` (tool_result) → patches the matching `dynamic-tool` part by
 *      `tool_use_id` to `output-available` / `output-error`
 *  - `system` (init) / `result` / `rate_limit_event` → not rendered
 *      (status comes from `sessionMeta`, not the transcript)
 *  - inbox `prompt` sends → user messages, interleaved chronologically
 */
import type { UIMessage } from 'ai'
import type { EventRow, InboxRow } from '~/utils/sessionStreamTypes'

type Part = UIMessage['parts'][number]

interface ClaudeBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

function asBlocks(content: unknown): ClaudeBlock[] {
  if (Array.isArray(content)) return content as ClaudeBlock[]
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return []
}

/** Flatten a tool_result `content` (string | block[]) to display text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const blk = b as ClaudeBlock
        if (typeof blk?.text === 'string') return blk.text
        return typeof b === 'string' ? b : JSON.stringify(b)
      })
      .join('\n')
  }
  if (content == null) return ''
  return typeof content === 'object' ? JSON.stringify(content) : String(content)
}

interface TimelineItem {
  ts: number
  ord: string
  message: UIMessage
}

/**
 * Build the chat transcript. `events` and `inbox` come straight off
 * `useSessionStream`; output is sorted chronologically and safe to feed
 * `UChatMessages`.
 */
export function projectSessionMessages(
  events: EventRow[],
  inbox: InboxRow[],
): UIMessage[] {
  const timeline: TimelineItem[] = []
  // toolCallId → the dynamic-tool part object, so a later tool_result can
  // patch it in place regardless of which assistant message it lives on.
  const toolParts = new Map<string, Record<string, unknown>>()

  for (const msg of inbox) {
    const type = msg.message_type
    if (type && type !== 'prompt') continue
    const payload = (msg.payload ?? {}) as { text?: unknown }
    if (typeof payload.text !== 'string') continue
    const ts = Date.parse(msg.timestamp)
    timeline.push({
      ts: Number.isNaN(ts) ? 0 : ts,
      ord: `i:${msg.key}`,
      message: {
        id: `prompt-${msg.key}`,
        role: 'user',
        parts: [{ type: 'text', text: payload.text, state: 'done' }],
      },
    })
  }

  const ordered = [...events].sort((a, b) =>
    a.ts !== b.ts ? a.ts - b.ts : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  )

  for (const evt of ordered) {
    if (evt.type === 'assistant') {
      const message = (evt.payload as { message?: { content?: unknown } })
        .message
      const blocks = asBlocks(message?.content)
      const parts: Part[] = []
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push({ type: 'text', text: b.text, state: 'done' })
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          parts.push({ type: 'reasoning', text: b.thinking, state: 'done' })
        } else if (b.type === 'tool_use' && b.id && b.name) {
          const part = {
            type: 'dynamic-tool',
            toolName: b.name,
            toolCallId: b.id,
            state: 'input-available',
            input: b.input ?? {},
          } as Record<string, unknown>
          toolParts.set(b.id, part)
          parts.push(part as unknown as Part)
        }
      }
      if (parts.length === 0) continue
      timeline.push({
        ts: evt.ts,
        ord: `e:${evt.key}`,
        message: { id: `a-${evt.key}`, role: 'assistant', parts },
      })
    } else if (evt.type === 'user') {
      const message = (evt.payload as { message?: { content?: unknown } })
        .message
      for (const b of asBlocks(message?.content)) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const part = toolParts.get(b.tool_use_id)
        if (!part) continue
        if (b.is_error) {
          part.state = 'output-error'
          part.errorText = resultText(b.content)
          delete part.output
        } else {
          part.state = 'output-available'
          part.output = b.content
        }
      }
    }
    // system / result / rate_limit_event: intentionally not rendered.
  }

  return timeline
    .sort((a, b) =>
      a.ts !== b.ts ? a.ts - b.ts : a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0,
    )
    .map((t) => t.message)
}
