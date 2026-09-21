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

/**
 * One collapsed run of tool activity. It carries the items it stands for, so
 * expanding it is a matter of rendering them — there is no second lookup and
 * nothing to re-derive.
 */
export interface ActivityGroup {
  id: string
  seq: number
  at: string
  kind: 'activity'
  items: TranscriptItem[]
  toolCalls: number
  thoughts: number
  failed: number
  names: Array<{ name: string, count: number }>
}

export type CondensedItem = TranscriptItem | ActivityGroup

export interface CondenseOptions {
  /** Runs shorter than this are left alone: one card is not clutter. */
  minRun?: number
  /** The session is still working, so a trailing thought is the live tail. */
  live?: boolean
}

function toolName(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  return item.tool.name || item.tool.title || 'Tool'
}

/** A run of `tool` / `thought` items, in the order they happened. */
function groupOf(run: TranscriptItem[]): ActivityGroup {
  const counts = new Map<string, number>()
  let toolCalls = 0
  let thoughts = 0
  let failed = 0

  for (const item of run) {
    if (item.kind === 'thought') {
      thoughts += 1
      continue
    }
    if (item.kind !== 'tool') continue
    toolCalls += 1
    if (item.tool.status === 'failed') failed += 1
    const name = toolName(item)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const first = run[0]!
  return {
    // Stable across re-renders: the first item's id does not move, so a group
    // the user expanded stays the same group while events stream in below it.
    id: `activity:${first.id}`,
    seq: first.seq,
    at: first.at,
    kind: 'activity',
    items: run,
    toolCalls,
    thoughts,
    failed,
    // Most frequent first; ties keep the order they first appeared in.
    names: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }
}

/**
 * The second pass over `buildTranscript()`'s output: what happened is already
 * decided, this only decides what to *draw*. Every maximal run of `tool` /
 * `thought` items becomes one `activity` row; everything else is passed
 * through untouched, so a pending permission is never swallowed by a group.
 *
 * The live tail stays open — a tool that is still running, or a trailing
 * thought while the session is working, renders on its own below the group, so
 * the user can always see what the agent is doing right now.
 */
export function condenseTranscript(
  items: TranscriptItem[],
  options: CondenseOptions = {}
): CondensedItem[] {
  const minRun = options.minRun ?? 2
  const last = items[items.length - 1]
  const tailIsLive = !!last && (
    (last.kind === 'tool' && (last.tool.status === 'pending' || last.tool.status === 'in_progress'))
    || (last.kind === 'thought' && !!options.live)
  )
  const end = tailIsLive ? items.length - 1 : items.length

  const out: CondensedItem[] = []
  let run: TranscriptItem[] = []

  const flush = () => {
    if (run.length >= minRun) out.push(groupOf(run))
    else out.push(...run)
    run = []
  }

  for (let index = 0; index < end; index += 1) {
    const item = items[index]!
    if (item.kind === 'tool' || item.kind === 'thought') {
      run.push(item)
      continue
    }
    flush()
    out.push(item)
  }
  flush()

  if (tailIsLive) out.push(last!)
  return out
}

/** "12 tool calls · 3 thoughts" — the one-line summary of a collapsed run. */
export function activityLabel(group: ActivityGroup): string {
  const parts: string[] = []
  if (group.toolCalls) parts.push(`${group.toolCalls} tool call${group.toolCalls === 1 ? '' : 's'}`)
  if (group.thoughts) parts.push(`${group.thoughts} thought${group.thoughts === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** "Read ×5, Bash ×4" — the per-tool breakdown behind the label. */
export function activityBreakdown(group: ActivityGroup): string {
  return group.names.map(entry => `${entry.name} ×${entry.count}`).join(', ')
}
