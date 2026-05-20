/**
 * Per-adapter, client-side projection: in-process engine `session_events`
 * (durable) ⊕ the latest live `partial` frame → AI SDK `UIMessage[]`.
 *
 * The adapter layer behind the design decision to standardize the UI
 * transcript on the AI SDK `UIMessage` shape: the durable log stays the
 * rich native claude stream-json envelope + a few Domo-synthesized types;
 * the UI only ever consumes `UIMessage[]`, so a future `ai`-package-based
 * agent can emit that shape natively and reuse the exact same renderer.
 *
 * Event types we fold in (`server/lib/sessionEngine/store.ts`):
 *  - `prompt` (Domo-synthesized) → a user message bubble (the raw text the
 *      user typed; slash/`@` expansion lives in the engine, not the
 *      transcript)
 *  - `assistant` → an assistant message; content blocks become parts:
 *      text → text part, thinking → reasoning part,
 *      tool_use → `dynamic-tool` part (state `input-available`)
 *  - `user` (tool_result) → patches the matching `dynamic-tool` part by
 *      `tool_use_id` to `output-available` / `output-error`
 *  - `steer_sent` (Domo-synthesized) → a user message bubble at send time;
 *      flips queued→delivered when the CLI's `--replay-user-messages` echo
 *      arrives with the same `uuid`
 *  - `user` with `isReplay` → NOT a bubble; only its `uuid` is harvested
 *      to mark the matching `steer_sent` delivered (the initial prompt's
 *      own replay is thus ignored — its bubble comes from the `prompt`
 *      event)
 *  - `system` (init) / `result` / `rate_limit_event` → not rendered
 *      (status is derived from events by the composable)
 *
 * The `partial` argument is the latest **live-only** coalesced streaming
 * delta (not persisted). It renders as a *streaming* assistant bubble
 * (text / reasoning parts, `state:'streaming'`) keyed on the Anthropic
 * `message.id` so when the complete `assistant` event arrives with the
 * same id it occupies the SAME bubble and grows in place. The composable
 * clears `partial` on the complete-`assistant` / `result` / `aborted` /
 * `error` boundary, so we don't need to track finalization here.
 */
import type { UIMessage } from 'ai'
import type { EventRow, PartialFrame } from '~/utils/sessionStreamTypes'

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
 * Build the chat transcript. `events` comes straight off `useSessionStream`;
 * `partial` is the latest live streaming frame (or null). Output is sorted
 * chronologically and safe to feed `UChatMessages`.
 */
export function projectSessionMessages(
  events: EventRow[],
  partial: PartialFrame | null = null,
): UIMessage[] {
  const timeline: TimelineItem[] = []
  // toolCallId → the dynamic-tool part object, so a later tool_result can
  // patch it in place regardless of which assistant message it lives on.
  const toolParts = new Map<string, Record<string, unknown>>()

  const ordered = [...events].sort((a, b) => a.seq - b.seq)

  // The CLI's `--replay-user-messages` echo is the consumption ack: a
  // `user` envelope with `isReplay` and the `uuid` we sent. Harvest those
  // uuids so a `steer_sent` bubble can show queued→delivered.
  const deliveredSteerUuids = new Set<string>()
  for (const evt of ordered) {
    if (evt.type === 'user') {
      const p = evt.payload as { isReplay?: unknown; uuid?: unknown }
      if (p.isReplay === true && typeof p.uuid === 'string') {
        deliveredSteerUuids.add(p.uuid)
      }
    }
  }

  for (const evt of ordered) {
    if (evt.type === 'prompt') {
      const p = evt.payload as { text?: unknown }
      if (typeof p.text !== 'string') continue
      timeline.push({
        ts: evt.createdAt,
        ord: `e:${evt.seq}`,
        message: {
          id: `prompt-${evt.seq}`,
          role: 'user',
          parts: [{ type: 'text', text: p.text, state: 'done' }],
        },
      })
    } else if (evt.type === 'steer_sent') {
      const p = evt.payload as { text?: unknown; uuid?: unknown }
      if (typeof p.text !== 'string') continue
      const delivered =
        typeof p.uuid === 'string' && deliveredSteerUuids.has(p.uuid)
      timeline.push({
        ts: evt.createdAt,
        ord: `e:${evt.seq}`,
        message: {
          id: `steer-${evt.seq}`,
          role: 'user',
          metadata: { steer: true, delivered },
          parts: [{ type: 'text', text: p.text, state: 'done' }],
        },
      })
    } else if (evt.type === 'assistant') {
      const message = (
        evt.payload as { message?: { content?: unknown; id?: unknown } }
      ).message
      // Stable bubble id keyed on the Anthropic message id (when
      // present) so the live `partial` frame and this final message
      // are the SAME bubble — it grows in place, no remount.
      const mid = typeof message?.id === 'string' ? message.id : ''
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
        ts: evt.createdAt,
        ord: `e:${evt.seq}`,
        message: {
          id: mid ? `a-msg-${mid}` : `a-${evt.seq}`,
          role: 'assistant',
          parts,
        },
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

  // The latest live partial: a streaming assistant bubble keyed on
  // `messageId` so when the complete `assistant` arrives with the same
  // id it occupies the SAME bubble and grows in place (no remount).
  // The composable clears `partial` on the complete-assistant /
  // result / aborted / error boundary, so we don't filter here.
  if (partial) {
    const parts: Part[] = []
    if (partial.thinking) {
      parts.push({
        type: 'reasoning',
        text: partial.thinking,
        state: 'streaming',
      })
    }
    if (partial.text) {
      parts.push({ type: 'text', text: partial.text, state: 'streaming' })
    }
    if (parts.length > 0) {
      timeline.push({
        ts: partial.createdAt,
        ord: `p:${partial.messageId}`,
        message: {
          id: `a-msg-${partial.messageId}`,
          role: 'assistant',
          parts,
        },
      })
    }
  }

  return timeline
    .sort((a, b) =>
      a.ts !== b.ts ? a.ts - b.ts : a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0,
    )
    .map((t) => t.message)
}
