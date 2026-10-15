import type { ToolCallView } from '~/utils/agentTranscript'

/**
 * Domo's own MCP tools, as each adapter reports a call to one.
 *
 * - Claude Code names the tool `mcp__domo__<tool>` and streams the arguments
 *   into `rawInput`.
 * - Codex titles it `mcp.domo.<tool>`, with `{ server, tool, arguments }` as
 *   its input and the MCP result under `rawOutput.result`.
 * - OpenCode runs tools from code: the call is an `execute` whose input is
 *   `await tools.domo.<tool>({ … })`, and the arguments it really used come
 *   back in `rawOutput.metadata.toolCalls` once it has finished.
 */

export interface DomoCall {
  /** The tool's own name, e.g. `message_agent`. */
  name: string
  args: Record<string, any>
  /** The parsed result, once there is one. */
  result: any
}

const OPENCODE_CALL = /^\s*(?:return\s+)?(?:await\s+)?tools\.domo\.(\w+)\(([\s\S]*)\)\s*;?\s*$/

/** The Domo tool a call is to, cheaply, or null. */
export function domoToolName(tool: ToolCallView): string | null {
  const named = /^mcp__domo__(\w+)$/.exec(tool.name ?? '') ?? /^mcp(?:__|\.)domo(?:__|\.)(\w+)$/.exec(tool.title ?? '')
  if (named) return named[1]!
  const input = tool.rawInput
  if (input && typeof input === 'object') {
    if (input.server === 'domo' && typeof input.tool === 'string') return input.tool
    if (typeof input.code === 'string') return OPENCODE_CALL.exec(input.code)?.[1] ?? null
  }
  return null
}

export function domoCall(tool: ToolCallView): DomoCall | null {
  const name = domoToolName(tool)
  if (!name) return null
  return { name, args: argsOf(tool) ?? {}, result: resultOf(tool) }
}

function argsOf(tool: ToolCallView): Record<string, any> | null {
  const input = tool.rawInput
  if (!input || typeof input !== 'object') return null
  if (input.server === 'domo') return input.arguments ?? null
  if (typeof input.code === 'string') {
    const used = tool.rawOutput?.metadata?.toolCalls
    if (Array.isArray(used) && used.length === 1 && used[0]?.input) return used[0].input
    const literal = OPENCODE_CALL.exec(input.code)?.[2]?.trim()
    return literal ? parseObjectLiteral(literal) : null
  }
  return input
}

function resultOf(tool: ToolCallView): any {
  const output = tool.rawOutput
  const text
    = output?.result?.content?.[0]?.text
      ?? (Array.isArray(output) ? output.find((part: any) => part?.type === 'text')?.text : undefined)
      ?? tool.content?.find((part: any) => part?.type === 'content' && part.content?.type === 'text')?.content.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * A JavaScript object literal as a model writes one — bare keys, trailing
 * commas, either quote — read without evaluating it. Anything cleverer (a
 * variable, a template string) is not data, and gives null.
 */
export function parseObjectLiteral(source: string): Record<string, any> | null {
  let json = ''
  for (let index = 0; index < source.length;) {
    const char = source[index]!
    if (char === '"' || char === '\'') {
      let value = ''
      let end = index + 1
      for (; end < source.length && source[end] !== char; end += 1) {
        if (source[end] === '\\') {
          value += source[end]! + (source[end + 1] ?? '')
          end += 1
        } else {
          value += source[end] === '"' ? '\\"' : source[end]
        }
      }
      json += `"${char === '\'' ? value.replace(/\\'/g, '\'') : value}"`
      index = end + 1
      continue
    }
    const key = /^[A-Za-z_$][\w$]*(?=\s*:)/.exec(source.slice(index))
    if (key) {
      json += `"${key[0]}"`
      index += key[0].length
      continue
    }
    if (char === ',' && /^,\s*[}\]]/.test(source.slice(index))) {
      index += 1
      continue
    }
    json += char
    index += 1
  }
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/** What the transcript knows the names of: ids in, titles out. */
export interface DomoNames {
  agent: (id: string) => string | null
  environment: (id: string) => string | null
  project: (id: string) => string | null
}

/** The agent an id names, by title where the transcript knows it. */
function agentName(id: unknown, names: DomoNames, result?: any): string | null {
  if (typeof id !== 'string' || !id) return null
  return result?.title ?? names.agent(id) ?? id
}

function environmentName(id: unknown, names: DomoNames, result?: any): string | null {
  if (typeof id !== 'string' || !id) return null
  return result?.name ?? names.environment(id) ?? id
}

function projectName(id: unknown, names: DomoNames, result?: any): string | null {
  if (typeof id !== 'string' || !id) return null
  return result?.name ?? names.project(id) ?? id
}

function count(list: unknown, noun: string): string | null {
  if (!Array.isArray(list)) return null
  return `${list.length} ${noun}${list.length === 1 ? '' : 's'}`
}

interface DomoToolView {
  icon: string
  /**
   * What the call did, naming the kind of thing it did it to: "Messaged
   * agent", "Retired environment". Drawn apart from the name that follows,
   * so the verb never reads as part of an agent's title.
   */
  action: (call: DomoCall) => string
  /** What it acted on: an agent's title, an environment's name. */
  subject?: (call: DomoCall, names: DomoNames) => string | null
  /** More about it, read after the name: a new title, a schedule, a prompt. */
  detail?: (call: DomoCall, names: DomoNames) => string | null
  /** The result, in a few words. */
  outcome?: (call: DomoCall) => string | null
}

const onAgent = (call: DomoCall, names: DomoNames) => agentName(call.args.agentId, names, call.result)
const onEnvironment = (call: DomoCall, names: DomoNames) =>
  environmentName(call.args.environmentId ?? call.args.devEnvironmentId, names, call.result)
const onProject = (call: DomoCall, names: DomoNames) => projectName(call.args.projectId, names, call.result)
const named = (value: unknown) => (typeof value === 'string' && value ? value : null)
/** An agent's own session when it names none: "Renamed itself", with nothing after. */
const ownOr = (call: DomoCall, onOther: string, onSelf: string) => (call.args.agentId ? onOther : onSelf)

export const DOMO_TOOLS: Record<string, DomoToolView> = {
  list_models: { icon: 'i-lucide-cpu', action: () => 'Listed models', outcome: call => count(call.result?.models, 'model') },
  list_agents: { icon: 'i-lucide-bot', action: () => 'Listed agents', outcome: call => count(call.result?.agents, 'agent') },
  get_agent: {
    icon: 'i-lucide-bot',
    action: () => 'Checked agent',
    subject: onAgent,
    outcome: call => call.result?.status ?? null
  },
  read_agent_transcript: {
    icon: 'i-lucide-scroll-text',
    action: call => ownOr(call, 'Read transcript of agent', 'Read its own transcript'),
    subject: (call, names) => (call.args.agentId ? onAgent(call, names) : null)
  },
  message_agent: { icon: 'i-lucide-send', action: () => 'Messaged agent', subject: onAgent, outcome: call => call.result?.outcome ?? null },
  cancel_agent_turn: {
    icon: 'i-lucide-circle-stop',
    action: () => 'Cancelled turn of agent',
    subject: onAgent,
    outcome: call => (call.result?.cancelled === false ? 'was not running' : null)
  },
  withdraw_queued_message: { icon: 'i-lucide-undo-2', action: () => 'Withdrew message to agent', subject: onAgent },
  answer_permission_request: {
    icon: 'i-lucide-shield-check',
    action: call => (call.args.reject ? 'Rejected permission for agent' : 'Answered permission for agent'),
    subject: onAgent,
    outcome: call => call.result?.optionName ?? call.args.optionId ?? null
  },
  spawn_agent: {
    icon: 'i-lucide-bot',
    action: () => 'Started agent',
    subject: call => named(call.args.title ?? call.result?.title),
    detail: call => named(call.args.prompt)
  },
  manage_agent_session: {
    icon: 'i-lucide-settings-2',
    action: (call) => {
      const verb = call.args.archived === true
        ? 'Archived'
        : call.args.archived === false ? 'Unarchived' : call.args.title ? 'Renamed' : 'Updated'
      return ownOr(call, `${verb} agent`, `${verb} itself`)
    },
    subject: (call, names) => (call.args.agentId ? agentName(call.args.agentId, names) : null),
    detail: call => (call.args.title ? `to "${call.args.title}"` : null)
  },
  subscribe_to_agent: { icon: 'i-lucide-bell-plus', action: () => 'Subscribed to agent', subject: onAgent },
  unsubscribe_from_agent: { icon: 'i-lucide-bell-minus', action: () => 'Unsubscribed from agent', subject: onAgent },
  list_subscriptions: { icon: 'i-lucide-bell', action: () => 'Listed subscriptions' },
  list_projects: { icon: 'i-lucide-folder-git-2', action: () => 'Listed projects', outcome: call => count(call.result?.projects, 'project') },
  create_project: {
    icon: 'i-lucide-folder-plus',
    action: () => 'Added project',
    subject: call => named(call.args.name) ?? named(call.args.repoPath),
    detail: call => (call.args.name ? named(call.args.repoPath) : null)
  },
  update_project: { icon: 'i-lucide-folder-pen', action: () => 'Renamed project', subject: onProject, detail: call => (call.args.name ? `to "${call.args.name}"` : null) },
  retire_project: { icon: 'i-lucide-folder-x', action: () => 'Retired project', subject: onProject },
  create_dev_environment: {
    icon: 'i-lucide-box',
    action: () => 'Created environment',
    subject: call => named(call.args.name ?? call.result?.name),
    detail: (call, names) => (call.args.projectId ? `in ${projectName(call.args.projectId, names)}` : null)
  },
  get_dev_environment: { icon: 'i-lucide-box', action: () => 'Checked environment', subject: onEnvironment, outcome: call => call.result?.status ?? null },
  update_dev_environment: {
    icon: 'i-lucide-box',
    action: (call) => {
      if (call.args.status === 'running') return 'Started environment'
      if (call.args.status === 'stopped') return 'Stopped environment'
      return 'Updated environment'
    },
    subject: onEnvironment
  },
  upgrade_dev_environment: { icon: 'i-lucide-circle-arrow-up', action: () => 'Upgraded environment', subject: onEnvironment },
  retire_dev_environment: { icon: 'i-lucide-archive', action: () => 'Retired environment', subject: onEnvironment },
  retry_environment_cleanup: { icon: 'i-lucide-rotate-cw', action: () => 'Retried cleanup of environment', subject: onEnvironment },
  list_environment_ports: { icon: 'i-lucide-ethernet-port', action: () => 'Listed ports of environment', subject: onEnvironment },
  forward_environment_port: {
    icon: 'i-lucide-ethernet-port',
    action: call => `${call.args.forward === false ? 'Stopped forwarding' : 'Forwarded'} port ${call.args.port ?? ''} of environment`.replace(/ {2}/, ' '),
    subject: onEnvironment
  },
  list_assistants: { icon: 'i-lucide-users', action: () => 'Listed assistants', outcome: call => count(call.result?.assistants, 'assistant') },
  create_assistant: { icon: 'i-lucide-user-plus', action: () => 'Created assistant', subject: call => named(call.args.name ?? call.result?.name) },
  update_assistant: {
    icon: 'i-lucide-user-pen',
    action: call => (call.args.archived === true ? 'Archived assistant' : call.args.archived === false ? 'Unarchived assistant' : 'Updated assistant'),
    subject: call => named(call.result?.name ?? call.args.name ?? call.args.assistantId)
  },
  hand_off: { icon: 'i-lucide-notebook-pen', action: () => 'Handed off to a fresh session' },
  list_voices: { icon: 'i-lucide-audio-lines', action: () => 'Listed voices', outcome: call => count(call.result?.voices, 'voice') },
  create_voice: { icon: 'i-lucide-audio-lines', action: () => 'Created voice', subject: call => named(call.args.name ?? call.result?.name) },
  generate_image: { icon: 'i-lucide-image', action: () => 'Generated image', detail: call => named(call.args.prompt) },
  schedule_task: {
    icon: 'i-lucide-calendar-clock',
    action: () => 'Scheduled task',
    subject: call => named(call.args.name ?? call.result?.name),
    detail: call => named(call.args.cronExpression ?? call.args.runAt)
  },
  list_scheduled_tasks: { icon: 'i-lucide-calendar', action: () => 'Listed scheduled tasks', outcome: call => count(call.result?.tasks, 'task') },
  update_scheduled_task: {
    icon: 'i-lucide-calendar-cog',
    action: (call) => {
      if (call.args.enabled === false) return 'Paused scheduled task'
      if (call.args.enabled === true) return 'Resumed scheduled task'
      return 'Updated scheduled task'
    },
    subject: call => named(call.args.name ?? call.result?.name)
  },
  run_scheduled_task: { icon: 'i-lucide-play', action: () => 'Ran scheduled task', subject: call => named(call.result?.name) },
  delete_scheduled_task: { icon: 'i-lucide-calendar-x', action: () => 'Deleted scheduled task', subject: call => named(call.result?.name) },
  notify_supervisor: { icon: 'i-lucide-bell-ring', action: () => 'Notified you' },
  get_usage_limits: { icon: 'i-lucide-gauge', action: () => 'Checked usage limits', detail: call => named(call.args.provider) }
}

export const NO_NAMES: DomoNames = { agent: () => null, environment: () => null, project: () => null }

export interface DomoCallView {
  icon: string
  action: string
  subject: string | null
  detail: string | null
  outcome: string | null
}

/** One line for a Domo tool call: its icon, what it did, to what, and how it went. */
export function describeDomoCall(call: DomoCall, names: DomoNames = NO_NAMES): DomoCallView {
  const view = DOMO_TOOLS[call.name]
  if (!view) {
    return { icon: 'i-lucide-house', action: call.name.replace(/_/g, ' '), subject: null, detail: null, outcome: null }
  }
  return {
    icon: view.icon,
    action: view.action(call),
    subject: view.subject?.(call, names) ?? null,
    detail: view.detail?.(call, names) ?? null,
    outcome: view.outcome?.(call) ?? null
  }
}

/** The same line as plain text: "Messaged agent: Builder". */
export function domoCallText(view: DomoCallView): string {
  return view.subject ? `${view.action}: ${view.subject}` : view.action
}

/** The tool's short name for a group's breakdown: "Listed agents ×3". */
export function domoToolLabel(name: string): string {
  const view = DOMO_TOOLS[name]
  return view ? view.action({ name, args: {}, result: null }) : name.replace(/_/g, ' ')
}
