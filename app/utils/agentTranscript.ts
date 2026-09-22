import type { AgentEvent, PendingPermission } from '~~/shared/types'

export interface ToolCallView {
  toolCallId: string
  title: string
  name?: string | null
  kind: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  locations: Array<{ path: string, line?: number | null }>
  rawInput?: any
  rawOutput?: any
  content: any[]
}

export type TranscriptItem =
  | { id: string, seq: number, at: string, kind: 'user', text: string, attachments: Array<{ name: string, uri?: string }> }
  | { id: string, seq: number, at: string, kind: 'assistant', text: string, streaming: boolean }
  | { id: string, seq: number, at: string, kind: 'thought', text: string }
  | { id: string, seq: number, at: string, kind: 'tool', tool: ToolCallView }
  | { id: string, seq: number, at: string, kind: 'plan', entries: Array<{ content: string, status: string, priority: string }> }
  | { id: string, seq: number, at: string, kind: 'permission', permissionId: string, title: string, toolCall: any }
  | { id: string, seq: number, at: string, kind: 'notice', tone: 'info' | 'error', text: string }

const NOTICE_LABELS: Record<string, (payload: any) => string | null> = {
  turn_end: payload =>
    payload?.stopReason && payload.stopReason !== 'end_turn'
      ? `Turn ended: ${String(payload.stopReason).replace(/_/g, ' ')}`
      : null,
  cancelled: () => 'Turn cancelled',
  mode_changed: payload => `Mode set to ${payload?.modeId}`,
  model_changed: payload => `Model: ${payload?.name || payload?.modelId}`,
  'adapter-exit': payload =>
    `ACP adapter exited${payload?.code != null ? ` (code ${payload.code})` : ''}`,
  mesh_inbound: payload => `Message from agent "${payload?.fromTitle ?? payload?.from}": ${payload?.message}`,
  mesh_outbound: payload => `Sent to agent "${payload?.toTitle ?? payload?.to}": ${payload?.message}`,
  mesh_spawned: payload => `Spawned agent "${payload?.title}"`,
  mesh_message: payload => `Told the voice supervisor: ${payload?.message}`
}

function textFromContent(content: any): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (content.type === 'text') return content.text ?? ''
  return ''
}

/**
 * Fold the durable ACP event log into something renderable: tool calls collapse
 * onto their updates, the plan is always the latest one.
 *
 * Streaming text arrives as one `agent_message` / `agent_thought` row per block,
 * rewritten in place while it streams. Installs that predate that wrote one row
 * per delta (`…_chunk`), so those still merge into a single bubble here.
 */
export function buildTranscript(
  events: AgentEvent[],
  permissions: PendingPermission[] = []
): TranscriptItem[] {
  const items: TranscriptItem[] = []
  const toolIndex = new Map<string, number>()
  let assistantIndex: number | null = null
  let thoughtIndex: number | null = null

  const closeText = () => {
    assistantIndex = null
    thoughtIndex = null
  }

  for (const event of events) {
    const base = { id: event.id, seq: event.seq, at: event.createdAt }

    switch (event.type) {
      case 'user_message': {
        closeText()
        const blocks: any[] = event.payload?.content ?? []
        items.push({
          ...base,
          kind: 'user',
          text: blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n'),
          attachments: blocks
            .filter(block => block?.type === 'resource_link' || block?.type === 'resource' || block?.type === 'image')
            .map(block => ({ name: block.name ?? block.uri ?? 'attachment', uri: block.uri }))
        })
        break
      }

      case 'agent_message':
      case 'agent_thought': {
        const text: string = event.payload?.text ?? ''
        if (!text) break
        // A whole block: nothing merges into it, and nothing merges it into the
        // run of legacy chunks that may sit above it.
        closeText()
        items.push(
          event.type === 'agent_message'
            ? { ...base, kind: 'assistant', text, streaming: event.payload?.streaming !== false }
            : { ...base, kind: 'thought', text }
        )
        break
      }

      case 'agent_message_chunk': {
        const text = textFromContent(event.payload?.content)
        if (!text) break
        if (assistantIndex != null) {
          const item = items[assistantIndex] as Extract<TranscriptItem, { kind: 'assistant' }>
          item.text += text
        } else {
          items.push({ ...base, kind: 'assistant', text, streaming: true })
          assistantIndex = items.length - 1
          thoughtIndex = null
        }
        break
      }

      case 'agent_thought_chunk': {
        const text = textFromContent(event.payload?.content)
        if (!text) break
        if (thoughtIndex != null) {
          const item = items[thoughtIndex] as Extract<TranscriptItem, { kind: 'thought' }>
          item.text += text
        } else {
          items.push({ ...base, kind: 'thought', text })
          thoughtIndex = items.length - 1
          assistantIndex = null
        }
        break
      }

      case 'tool_call': {
        closeText()
        const payload = event.payload ?? {}
        const tool: ToolCallView = {
          toolCallId: payload.toolCallId,
          title: payload.title ?? payload.name ?? 'Tool call',
          name: payload.name ?? null,
          kind: payload.kind ?? 'other',
          status: payload.status ?? 'pending',
          locations: payload.locations ?? [],
          rawInput: payload.rawInput,
          rawOutput: payload.rawOutput,
          content: payload.content ?? []
        }
        items.push({ ...base, kind: 'tool', tool })
        toolIndex.set(tool.toolCallId, items.length - 1)
        break
      }

      case 'tool_call_update': {
        const payload = event.payload ?? {}
        const index = toolIndex.get(payload.toolCallId)
        if (index == null) break
        const item = items[index] as Extract<TranscriptItem, { kind: 'tool' }>
        const tool = item.tool
        if (payload.title) tool.title = payload.title
        if (payload.kind) tool.kind = payload.kind
        if (payload.status) tool.status = payload.status
        if (payload.locations) tool.locations = payload.locations
        if (payload.rawInput !== undefined) tool.rawInput = payload.rawInput
        if (payload.rawOutput !== undefined) tool.rawOutput = payload.rawOutput
        if (payload.content) tool.content = payload.content
        break
      }

      case 'plan':
      case 'plan_update': {
        const entries = event.payload?.entries
          ?? event.payload?.content?.entries
          ?? event.payload?.content?.items
          ?? []
        if (!entries.length) break
        const existing = items.findIndex(item => item.kind === 'plan')
        const planItem: TranscriptItem = {
          ...base,
          kind: 'plan',
          entries: entries.map((entry: any) => ({
            content: entry.content,
            status: entry.status,
            priority: entry.priority
          }))
        }
        // Updating the plan in place must not split the bubble that is streaming
        // below it; only a newly appended plan ends the current text run.
        if (existing >= 0) {
          items[existing] = planItem
        } else {
          closeText()
          items.push(planItem)
        }
        break
      }

      case 'permission_request': {
        closeText()
        items.push({
          ...base,
          kind: 'permission',
          permissionId: event.payload?.permissionId,
          title: event.payload?.toolCall?.title ?? 'Permission needed',
          toolCall: event.payload?.toolCall
        })
        break
      }

      case 'error': {
        closeText()
        items.push({ ...base, kind: 'notice', tone: 'error', text: event.payload?.message ?? 'Unknown error' })
        break
      }

      // Context occupancy is session state and lives on `agent_sessions.usage`;
      // nothing writes it here any more and the schema deletes the rows an
      // older install left behind. Named explicitly all the same, because the
      // rows can still arrive from a database the app has not booted on yet —
      // and because falling through must not `closeText()` and split the
      // message one of them landed in the middle of.
      case 'usage_update':
        break

      default: {
        const label = NOTICE_LABELS[event.type]?.(event.payload)
        if (label) {
          closeText()
          items.push({ ...base, kind: 'notice', tone: 'info', text: label })
        }
        break
      }
    }
  }

  // A permission that has been answered is history, not a prompt.
  const resolved = new Set(permissions.filter(p => p.resolvedAt).map(p => p.id))
  return items.filter(item => item.kind !== 'permission' || !resolved.has(item.permissionId))
}

export const TOOL_KIND_ICONS: Record<string, string> = {
  read: 'i-lucide-book-open',
  edit: 'i-lucide-file-pen-line',
  delete: 'i-lucide-trash-2',
  move: 'i-lucide-folder-input',
  search: 'i-lucide-search',
  execute: 'i-lucide-terminal',
  think: 'i-lucide-brain',
  fetch: 'i-lucide-globe',
  switch_mode: 'i-lucide-toggle-right',
  other: 'i-lucide-wrench'
}

export const TOOL_STATUS_META: Record<string, { color: 'neutral' | 'primary' | 'success' | 'error', label: string }> = {
  pending: { color: 'neutral', label: 'Pending' },
  in_progress: { color: 'primary', label: 'Running' },
  completed: { color: 'success', label: 'Done' },
  failed: { color: 'error', label: 'Failed' }
}
