import { isSpokenNote } from '~~/shared/agent-voice'
import {
  HANDOFF_CONTINUE_PREFIX,
  HANDOFF_REASON_LABELS,
  isAssistantContext,
  isHandoffContinuation,
  isHandoffRequest
} from '~~/shared/assistants'
import type { AgentEvent, HandoffReason, PendingPermission } from '~~/shared/types'
import { domoCall, domoToolLabel, domoToolName } from '~/utils/domoTools'
import { dayKey } from '~/utils/format'

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
  /** The tool calls of the subagent this call spawned, in order. */
  children?: ToolCallView[]
}

export type TranscriptItem =
  | { id: string, seq: number, at: string, kind: 'user', text: string, attachments: Array<{ name: string, uri?: string }>, spoken: boolean }
  | { id: string, seq: number, at: string, kind: 'assistant', text: string, streaming: boolean }
  | { id: string, seq: number, at: string, kind: 'thought', text: string }
  | { id: string, seq: number, at: string, kind: 'tool', tool: ToolCallView }
  | { id: string, seq: number, at: string, kind: 'plan', entries: Array<{ content: string, status: string, priority: string }> }
  | { id: string, seq: number, at: string, kind: 'permission', permissionId: string, title: string, toolCall: any }
  | { id: string, seq: number, at: string, kind: 'notice', tone: 'info' | 'error', text: string }
  /** Where an assistant's session took over from the one before: the note it started from. */
  | { id: string, seq: number, at: string, kind: 'handoff', reason: HandoffReason, note: string, sessionId: string }
  | MeshItem

/**
 * How one agent's message reached another, or reached the person:
 * - `message`: `message_agent`, seen from either end;
 * - `spawn`: the task `spawn_agent` handed a new agent;
 * - `notify`: `notify_supervisor`, which goes to the person;
 * - `update`: Domo telling a subscriber what an agent it follows did;
 * - `schedule`: a scheduled task firing; its peer is the task, not an agent;
 * - `domo`: any other note from Domo itself.
 */
export type MeshVia = 'message' | 'spawn' | 'notify' | 'update' | 'schedule' | 'domo'

/**
 * Traffic between agents, as one item at each end: the sender's tool call and
 * the prompt it became for the receiver. Never folded into a run of tool
 * activity — who is talking to whom is the conversation, not its workings.
 */
export interface MeshItem {
  id: string
  seq: number
  at: string
  kind: 'mesh'
  direction: 'in' | 'out'
  via: MeshVia
  /**
   * The other end: an agent, or for `schedule` the task. Both null is the
   * person (`notify`) or Domo (`domo`).
   */
  peer: { id: string | null, title: string | null }
  text: string
  /** The sender's tool call, for its status and result. */
  tool: ToolCallView | null
}

/**
 * A setting changed on a session with no adapter running is a request, not a
 * fact: the row holds it and the next attach applies it. The server marks
 * those events `pending` rather than starting a process to make the line true
 * (see `pendingMark` in `server/lib/acp/manager.ts`), and the line says so —
 * otherwise a transcript would claim a mode took effect on a session that has
 * not run since.
 */
const whenPending = (payload: any) => (payload?.pending ? ' (when it next starts)' : '')

const NOTICE_LABELS: Record<string, (payload: any) => string | null> = {
  /**
   * A turn nobody asked for.
   *
   * Every other turn opens with a `user_message`, and that row is what tells a
   * reader the text under it is an answer to something. An agent that wakes
   * itself — a scheduled wake-up, a background task reporting back, a watched
   * condition changing — writes none, so without this its output is welded to
   * the end of the previous exchange and there is no way to tell, scrolling
   * back, whether it was asked for. `server/lib/acp/manager.ts` only ever
   * appends this for `origin: 'adapter'`, which is why there is no other
   * wording: a prompted turn has its prompt to introduce it.
   */
  turn_start: payload =>
    payload?.origin === 'adapter' ? 'The agent started this turn on its own' : null,
  turn_end: payload =>
    payload?.stopReason && payload.stopReason !== 'end_turn'
      ? `Turn ended: ${String(payload.stopReason).replace(/_/g, ' ')}`
      : null,
  cancelled: () => 'Turn cancelled',
  // Events from before the name was recorded fall back to the adapter's id.
  mode_changed: payload => `Mode set to ${payload?.name || payload?.modeId}${whenPending(payload)}`,
  model_changed: payload => `Model: ${payload?.name || payload?.modelId}${whenPending(payload)}`,
  // The adapter's own settings, whose names are the adapter's too:
  // "Effort: High" on Claude Code, "Reasoning effort: High" on Codex.
  config_changed: payload => `${payload?.name || payload?.configId}: ${payload?.value}${whenPending(payload)}`,
  'adapter-exit': payload =>
    `The agent's process stopped${payload?.code != null ? ` (exit code ${payload.code})` : ''}`,
  handed_off: () => 'Handed off to a new session',
  environment_retired: () =>
    'Its development environment was retired — this session can no longer be started',
  environment_upgraded: payload => payload?.home === 'lost'
    ? 'Its development environment got a new container, without its old home — this session starts afresh'
    : 'Its development environment got a new container — the next turn resumes on it'
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
  const tools = new Map<string, ToolCallView>()
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
        // An assistant's identity rides on its session's first prompt when the
        // harness has no system prompt; Domo put it there, so it is not shown.
        const blocks: any[] = (event.payload?.content ?? []).filter((block: any) => !isAssistantContext(block?.text))
        // Domo asking for a handoff note, or starting the next session on
        // work the last one left: said by Domo, so shown as a line, not a bubble.
        if (blocks.some(block => isHandoffRequest(block?.text))) {
          items.push({ ...base, kind: 'notice', tone: 'info', text: 'Writing a handoff note for a fresh session' })
          break
        }
        const continuation = blocks.find(block => isHandoffContinuation(block?.text))
        if (continuation) {
          items.push({ ...base, kind: 'notice', tone: 'info', text: `Carrying on: ${continuation.text.slice(HANDOFF_CONTINUE_PREFIX.length).trim()}` })
          break
        }
        // A turn that handed over several queued messages is one row with a
        // divider before each; the reader gets them as the separate messages
        // they were.
        for (const [index, part] of promptParts({ ...event.payload, content: blocks }).entries()) {
          items.push(promptItem(index ? { ...base, id: `${base.id}:${index}` } : base, part))
        }
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
        const payload = event.payload ?? {}
        // A subagent's call goes inside the `Agent` call that spawned it, and
        // does not end the message the agent is writing alongside it.
        const parent = tools.get(payload._meta?.claudeCode?.parentToolUseId)
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
        tools.set(tool.toolCallId, tool)
        if (parent && parent !== tool) {
          parent.children = [...(parent.children ?? []), tool]
          break
        }
        closeText()
        items.push({ ...base, kind: 'tool', tool })
        break
      }

      case 'tool_call_update': {
        const payload = event.payload ?? {}
        const tool = tools.get(payload.toolCallId)
        if (!tool) break
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

      case 'handoff': {
        closeText()
        items.push({
          ...base,
          kind: 'handoff',
          reason: event.payload?.reason ?? 'user',
          note: event.payload?.note ?? '',
          sessionId: event.agentSessionId
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
  return items
    .filter(item => item.kind !== 'permission' || !resolved.has(item.permissionId))
    .filter(item => item.kind !== 'tool' || !isRoutineReview(item.tool))
    .map(item => (item.kind === 'tool' ? sentMessage(item) ?? item : item))
}

/**
 * Codex's own reviewer passing a call it was about to make: a second row for
 * every call, saying only that it may go ahead. One that is still deciding is
 * left out too, so a review that passes never draws a row and takes it away
 * again; one that refused is the news, and stays.
 */
function isRoutineReview(tool: ToolCallView): boolean {
  const review = tool.rawOutput?.review ?? tool.rawInput?.review
  if (!review || !(tool.rawOutput?.action ?? tool.rawInput?.action)) return false
  if (tool.status === 'failed') return false
  return tool.status !== 'completed' || review.status === 'approved'
}

/* -------------------------------------------------------------------------
 * Traffic between agents
 * ------------------------------------------------------------------------- */

/**
 * `combineInboxContent`'s divider (`inboxDivider`), in its own block before
 * each message. "[From you]" is what older rows said for the human and for a
 * scheduled task alike.
 */
const DIVIDER = /^\n?\[(?:Message from agent (\S+)|(From Domo)|(From the human|From you)|(From a scheduled task))\]\n?$/

/** The origin a divider names; a scheduled task's id is not in it. */
function dividerOrigin(divider: RegExpExecArray): string | null {
  if (divider[1]) return `agent:${divider[1]}`
  if (divider[2]) return 'system'
  if (divider[3]) return 'user'
  if (divider[4]) return 'cron:'
  return null
}
/** What `message_agent` puts before the message it delivers. */
const FROM_AGENT = /^\[Message from agent "([\s\S]*?)" \((ag_\w+)\)\]\n*/
/** What the scheduler puts before the prompt it delivers. */
const FROM_SCHEDULE = /^\[Scheduled task "([\s\S]*?)" \((\w+)\)\]\n*/
/** How Domo's notes about an agent begin. */
const ABOUT_AGENT = /^Agent (.+?) \((ag_\w+)\) /
/**
 * The same, for a note written before prompts said who sent them — narrow, so
 * that a person typing "Agent …" is not mistaken for one.
 */
const SUBSCRIPTION_NOTE = /^Agent .+? \(ag_\w+\) (?:finished its turn|stopped|is waiting for a permission)/

interface PromptPart {
  /** `MessageOrigin`, where the row or a divider says; null where neither does. */
  origin: string | null
  blocks: any[]
}

function promptParts(payload: any): PromptPart[] {
  const blocks: any[] = payload?.content ?? []
  const parts: PromptPart[] = []
  let current: PromptPart = { origin: payload?.origin ?? null, blocks: [] }
  for (const block of blocks) {
    const divider = block?.type === 'text' ? DIVIDER.exec(block.text ?? '') : null
    if (!divider) {
      current.blocks.push(block)
      continue
    }
    if (current.blocks.length) parts.push(current)
    current = { origin: dividerOrigin(divider), blocks: [] }
  }
  if (current.blocks.length || !parts.length) parts.push(current)
  return parts
}

function promptItem(base: { id: string, seq: number, at: string }, part: PromptPart): TranscriptItem {
  // A spoken turn carries a note for the agent saying so; the reader gets a
  // microphone instead of the note.
  const texts = part.blocks.filter(block => block?.type === 'text')
  const text = texts.filter(block => !isSpokenNote(block.text)).map(block => block.text).join('\n')
  const mesh = (via: MeshVia, peer: MeshItem['peer'], body: string): MeshItem =>
    ({ ...base, kind: 'mesh', direction: 'in', via, peer, text: body.trim(), tool: null })

  const fromAgent = FROM_AGENT.exec(text)
  if (fromAgent) return mesh('message', { id: fromAgent[2]!, title: fromAgent[1]! }, text.slice(fromAgent[0].length))
  const fromSchedule = FROM_SCHEDULE.exec(text)
  if (fromSchedule) return mesh('schedule', { id: fromSchedule[2]!, title: fromSchedule[1]! }, text.slice(fromSchedule[0].length))
  if (part.origin?.startsWith('agent:')) {
    // From an agent, without `message_agent`'s heading: the task it was
    // started with.
    return mesh('spawn', { id: part.origin.slice('agent:'.length), title: null }, text)
  }
  if (part.origin === 'system' || (!part.origin && SUBSCRIPTION_NOTE.test(text))) {
    const about = ABOUT_AGENT.exec(text)
    return about
      ? mesh('update', { id: about[2]!, title: about[1]! }, text.slice(about[0].length))
      : mesh('domo', { id: null, title: null }, text)
  }

  return {
    ...base,
    kind: 'user',
    spoken: texts.some(block => isSpokenNote(block.text)),
    text,
    attachments: part.blocks
      .filter(block => block?.type === 'resource_link' || block?.type === 'resource' || block?.type === 'image')
      .map(block => ({ name: block.name ?? block.uri ?? 'attachment', uri: block.uri }))
  }
}

const SENDS: Record<string, MeshVia> = {
  message_agent: 'message',
  spawn_agent: 'spawn',
  notify_supervisor: 'notify'
}

/** A tool call that sent a message, as the message it sent. */
function sentMessage(item: Extract<TranscriptItem, { kind: 'tool' }>): MeshItem | null {
  const name = domoToolName(item.tool)
  const via = name ? SENDS[name] : undefined
  if (!via) return null
  const { args, result } = domoCall(item.tool)!
  const ok = result && typeof result === 'object'
  const peer: MeshItem['peer']
    = via === 'message'
      ? { id: args.agentId ?? (ok ? result.agentId : null) ?? null, title: (ok ? result.title : null) ?? null }
      : via === 'spawn'
        ? { id: (ok ? result.id : null) ?? null, title: args.title ?? (ok ? result.title : null) ?? null }
        : { id: null, title: null }
  const text = via === 'spawn' ? args.prompt : args.message
  return {
    id: item.id,
    seq: item.seq,
    at: item.at,
    kind: 'mesh',
    direction: 'out',
    via,
    peer,
    text: typeof text === 'string' ? text : '',
    tool: item.tool
  }
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
  /**
   * The run is still going: its last item is what the agent is doing right
   * now, and the next tool call will join it.
   */
  live: boolean
}

export type CondensedItem = TranscriptItem | ActivityGroup

export interface CondenseOptions {
  /** The session is still working, so the trailing run is still open. */
  live?: boolean
}

function toolName(item: Extract<TranscriptItem, { kind: 'tool' }>): string {
  const domo = domoToolName(item.tool)
  if (domo) return domoToolLabel(domo)
  return item.tool.name || item.tool.title || 'Tool'
}

/** A run of `tool` / `thought` items, in the order they happened. */
function groupOf(run: TranscriptItem[], live = false): ActivityGroup {
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
    names: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    live
  }
}

const isRunning = (item: TranscriptItem) =>
  item.kind === 'tool' && (item.tool.status === 'pending' || item.tool.status === 'in_progress')

/**
 * The second pass over `buildTranscript()`'s output: what happened is already
 * decided, this only decides what to *draw*. Every maximal run of `tool` /
 * `thought` items becomes one `activity` row, however short; everything else
 * is passed through untouched, so a pending permission is never swallowed by
 * a group.
 *
 * However short, because a row must be the same row from its first item to
 * its last. A run drawn as a plain card until a second call made it a group —
 * or a group until the run ended and it fell back to a card — swapped one
 * element for another of a different height, and moved everything around it.
 *
 * The run at the end of a working session is open: the call that is running
 * is its last item, and the group's header says so.
 */
export function condenseTranscript(
  items: TranscriptItem[],
  options: CondenseOptions = {}
): CondensedItem[] {
  const last = items[items.length - 1]
  const open = !!last && (isRunning(last) || (!!options.live && (last.kind === 'tool' || last.kind === 'thought')))

  const out: CondensedItem[] = []
  let run: TranscriptItem[] = []

  const flush = (live = false) => {
    if (run.length) out.push(groupOf(run, live))
    run = []
  }

  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'thought') {
      run.push(item)
      continue
    }
    flush()
    out.push(item)
  }
  flush(open)

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

/**
 * Whether two builds produced the same item, cheaply enough to ask on every
 * delta.
 *
 * Everything a transcript item holds that is big — a tool's content, its raw
 * input and output — is the event payload's own object, handed through
 * untouched by `buildTranscript`. A payload is replaced whole when its row
 * changes and is the same object when it does not, so reference equality
 * answers "did this change" exactly, without walking any of it. The small
 * fields are compared by value because the builder rewrites them: a tool's
 * title and status are edited in place by later updates, and streamed text is
 * concatenated.
 */
function sameTool(mine: ToolCallView, theirs: ToolCallView): boolean {
  return mine.status === theirs.status
    && mine.title === theirs.title
    && mine.kind === theirs.kind
    && mine.name === theirs.name
    && mine.content === theirs.content
    && mine.rawInput === theirs.rawInput
    && mine.rawOutput === theirs.rawOutput
    && mine.locations === theirs.locations
    && sameChildren(mine.children, theirs.children)
}

function sameChildren(a: ToolCallView[] = [], b: ToolCallView[] = []): boolean {
  return a.length === b.length && a.every((child, index) => {
    const other = b[index]!
    return child.status === other.status && child.title === other.title && child.content === other.content
  })
}

function sameItem(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a === b) return true
  if (a.id !== b.id || a.kind !== b.kind) return false

  switch (a.kind) {
    case 'user': {
      const other = b as typeof a
      return a.text === other.text && a.attachments.length === other.attachments.length
    }
    case 'assistant': {
      const other = b as typeof a
      return a.text === other.text && a.streaming === other.streaming
    }
    case 'thought':
    case 'notice':
      return a.text === (b as typeof a).text
    case 'handoff':
      return a.note === (b as typeof a).note
    case 'tool':
      return sameTool(a.tool, (b as typeof a).tool)
    case 'mesh': {
      const other = b as typeof a
      return a.direction === other.direction
        && a.via === other.via
        && a.text === other.text
        && a.peer.id === other.peer.id
        && a.peer.title === other.peer.title
        && (a.tool === other.tool || (!!a.tool && !!other.tool && sameTool(a.tool, other.tool)))
    }
    case 'plan': {
      const other = b as typeof a
      return a.entries.length === other.entries.length
        && a.entries.every((entry, index) => {
          const theirs = other.entries[index]!
          return entry.content === theirs.content && entry.status === theirs.status
        })
    }
    case 'permission':
      return a.toolCall === (b as typeof a).toolCall
  }
}

/**
 * Carry forward the objects that did not change.
 *
 * `buildTranscript` is a fold over the whole log, so it allocates a new item
 * for every line every time it runs — and a new object is, to Vue, a changed
 * prop: one streamed word re-rendered the whole transcript, markdown and diffs
 * included. The fold stays whole, because that is what keeps it readable; this
 * hands back the previous object wherever the new one says the same thing, so
 * what re-renders is what actually moved.
 */
export function reconcileTranscript(
  previous: TranscriptItem[],
  next: TranscriptItem[]
): TranscriptItem[] {
  if (!previous.length) return next
  const before = new Map(previous.map(item => [item.id, item]))
  return next.map((item) => {
    const old = before.get(item.id)
    return old && sameItem(old, item) ? old : item
  })
}

/**
 * The same, for the condensed pass. A group is unchanged when it stands for
 * exactly the same items, which — once `reconcileTranscript` has run — is one
 * reference check per item.
 */
export function reconcileCondensed(
  previous: CondensedItem[],
  next: CondensedItem[]
): CondensedItem[] {
  if (!previous.length) return next
  const groups = new Map<string, ActivityGroup>()
  for (const item of previous) {
    if (item.kind === 'activity') groups.set(item.id, item)
  }
  // Everything that is not a group passed through `condenseTranscript`
  // untouched, so `reconcileTranscript` has already settled its identity.
  return next.map((item) => {
    if (item.kind !== 'activity') return item
    const old = groups.get(item.id)
    const same = old
      && old.live === item.live
      && old.items.length === item.items.length
      && old.items.every((entry, index) => entry === item.items[index])
    return same ? old : item
  })
}

/** "Fresh session · the context window was filling up" — the line a handoff draws. */
export function handoffLabel(reason: HandoffReason): string {
  return `New session · ${HANDOFF_REASON_LABELS[reason] ?? 'handed off'}`
}

/** The line naming a day, above the first row of that day: a row of its own. */
export interface DayRow {
  id: string
  kind: 'day'
  at: string
}

/** What a transcript draws, one virtual row each. */
export type TranscriptRowModel = CondensedItem | DayRow

/**
 * The rows to draw: a day's line before the first row of each day, as a row
 * of its own rather than part of the row under it.
 *
 * Part of the row, it made that row's height depend on the row before it — and
 * the row before the first loaded one arrives later, with the page above it.
 * The row then lost its line and changed height under the reader. As a row of
 * its own, keyed by its day, the line just moves up to the new first row of
 * that day, and no row changes height.
 *
 * `previous` holds the lines drawn last time, so one that has not moved keeps
 * its identity, as every other row does.
 */
export function withDayRows(
  items: CondensedItem[],
  previous: Map<string, DayRow> = new Map()
): TranscriptRowModel[] {
  const out: TranscriptRowModel[] = []
  let day: string | null = null
  for (const item of items) {
    const key = dayKey(item.at)
    if (key !== day) {
      day = key
      const id = `day:${key}`
      const kept = previous.get(id)
      const row = kept && kept.at === item.at ? kept : { id, kind: 'day' as const, at: item.at }
      previous.set(id, row)
      out.push(row)
    }
    out.push(item)
  }
  return out
}
