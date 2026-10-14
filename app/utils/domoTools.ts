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

const quoted = (value: unknown) => (value == null || value === '' ? null : `"${value}"`)

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
  /** What the call does, as a person would say it. */
  label: (call: DomoCall) => string
  /** What it acted on: an agent's title, an environment's name. */
  subject?: (call: DomoCall, names: DomoNames) => string | null
  /** The result, in a few words. */
  outcome?: (call: DomoCall) => string | null
}

const onAgent = (call: DomoCall, names: DomoNames) => agentName(call.args.agentId, names, call.result)
const onOwnOrAgent = (call: DomoCall, names: DomoNames) =>
  call.args.agentId ? agentName(call.args.agentId, names, call.result) : 'itself'
const onEnvironment = (call: DomoCall, names: DomoNames) =>
  environmentName(call.args.environmentId ?? call.args.devEnvironmentId, names, call.result)
const onProject = (call: DomoCall, names: DomoNames) => projectName(call.args.projectId, names, call.result)

export const DOMO_TOOLS: Record<string, DomoToolView> = {
  list_models: { icon: 'i-lucide-cpu', label: () => 'List models', outcome: call => count(call.result?.models, 'model') },
  list_agents: { icon: 'i-lucide-bot', label: () => 'List agents', outcome: call => count(call.result?.agents, 'agent') },
  get_agent: {
    icon: 'i-lucide-bot',
    label: () => 'Check agent',
    subject: onAgent,
    outcome: call => call.result?.status ?? null
  },
  read_agent_transcript: { icon: 'i-lucide-scroll-text', label: () => 'Read transcript of', subject: onOwnOrAgent },
  message_agent: { icon: 'i-lucide-send', label: () => 'Message', subject: onAgent, outcome: call => call.result?.outcome ?? null },
  cancel_agent_turn: {
    icon: 'i-lucide-circle-stop',
    label: () => 'Cancel the turn of',
    subject: onAgent,
    outcome: call => (call.result?.cancelled === false ? 'was not running' : null)
  },
  withdraw_queued_message: { icon: 'i-lucide-undo-2', label: () => 'Withdraw a message to', subject: onAgent },
  answer_permission_request: {
    icon: 'i-lucide-shield-check',
    label: call => (call.args.reject ? 'Reject a permission for' : 'Answer a permission for'),
    subject: onAgent,
    outcome: call => call.result?.optionName ?? call.args.optionId ?? null
  },
  spawn_agent: {
    icon: 'i-lucide-bot',
    label: () => 'Start agent',
    subject: call => quoted(call.args.title ?? call.result?.title)
  },
  manage_agent_session: {
    icon: 'i-lucide-settings-2',
    label: (call) => {
      if (call.args.archived === true) return 'Archive'
      if (call.args.archived === false) return 'Unarchive'
      if (call.args.title) return 'Rename'
      return 'Update'
    },
    subject: (call, names) => {
      const target = call.args.agentId ? agentName(call.args.agentId, names) : 'itself'
      return call.args.title ? `${target} to "${call.args.title}"` : target
    }
  },
  subscribe_to_agent: { icon: 'i-lucide-bell-plus', label: () => 'Follow', subject: onAgent },
  unsubscribe_from_agent: { icon: 'i-lucide-bell-minus', label: () => 'Stop following', subject: onAgent },
  list_subscriptions: { icon: 'i-lucide-bell', label: () => 'List subscriptions' },
  list_projects: { icon: 'i-lucide-folder-git-2', label: () => 'List projects', outcome: call => count(call.result?.projects, 'project') },
  create_project: { icon: 'i-lucide-folder-plus', label: () => 'Add project', subject: call => quoted(call.args.name) ?? call.args.repoPath ?? null },
  update_project: { icon: 'i-lucide-folder-pen', label: () => 'Rename project', subject: (call, names) => `${onProject(call, names)} to "${call.args.name}"` },
  retire_project: { icon: 'i-lucide-folder-x', label: () => 'Retire project', subject: onProject },
  create_dev_environment: {
    icon: 'i-lucide-box',
    label: () => 'Create environment',
    subject: (call, names) => {
      const project = call.args.projectId ? projectName(call.args.projectId, names) : null
      return [quoted(call.args.name), project && `in ${project}`].filter(Boolean).join(' ') || null
    }
  },
  get_dev_environment: { icon: 'i-lucide-box', label: () => 'Check environment', subject: onEnvironment, outcome: call => call.result?.status ?? null },
  update_dev_environment: {
    icon: 'i-lucide-box',
    label: (call) => {
      if (call.args.status === 'running') return 'Start environment'
      if (call.args.status === 'stopped') return 'Stop environment'
      return 'Update environment'
    },
    subject: onEnvironment
  },
  retire_dev_environment: { icon: 'i-lucide-archive', label: () => 'Retire environment', subject: onEnvironment },
  retry_environment_cleanup: { icon: 'i-lucide-rotate-cw', label: () => 'Retry cleanup of', subject: onEnvironment },
  list_environment_ports: { icon: 'i-lucide-ethernet-port', label: () => 'List ports of', subject: onEnvironment },
  forward_environment_port: {
    icon: 'i-lucide-ethernet-port',
    label: call => `${call.args.forward === false ? 'Stop forwarding' : 'Forward'} port ${call.args.port ?? ''}`.trim(),
    subject: onEnvironment
  },
  schedule_task: {
    icon: 'i-lucide-calendar-clock',
    label: () => 'Schedule',
    subject: call => [quoted(call.args.name), call.args.cronExpression ?? call.args.runAt].filter(Boolean).join(' · ') || null
  },
  list_scheduled_tasks: { icon: 'i-lucide-calendar', label: () => 'List scheduled tasks', outcome: call => count(call.result?.tasks, 'task') },
  update_scheduled_task: {
    icon: 'i-lucide-calendar-cog',
    label: (call) => {
      if (call.args.enabled === false) return 'Pause scheduled task'
      if (call.args.enabled === true) return 'Resume scheduled task'
      return 'Update scheduled task'
    },
    subject: call => quoted(call.args.name ?? call.result?.name)
  },
  run_scheduled_task: { icon: 'i-lucide-play', label: () => 'Run scheduled task', subject: call => quoted(call.result?.name) },
  delete_scheduled_task: { icon: 'i-lucide-calendar-x', label: () => 'Delete scheduled task', subject: call => quoted(call.result?.name) },
  notify_supervisor: { icon: 'i-lucide-bell-ring', label: () => 'Notify you' },
  get_usage_limits: { icon: 'i-lucide-gauge', label: () => 'Check usage limits', subject: call => call.args.provider ?? null }
}

export const NO_NAMES: DomoNames = { agent: () => null, environment: () => null, project: () => null }

/** One line for a Domo tool call: its icon, what it did, to what, and how it went. */
export function describeDomoCall(call: DomoCall, names: DomoNames = NO_NAMES) {
  const view = DOMO_TOOLS[call.name]
  if (!view) {
    return { icon: 'i-lucide-house', label: call.name.replace(/_/g, ' '), subject: null, outcome: null }
  }
  return {
    icon: view.icon,
    label: view.label(call),
    subject: view.subject?.(call, names) ?? null,
    outcome: view.outcome?.(call) ?? null
  }
}

/** The tool's short name for a group's breakdown: "List agents ×3". */
export function domoToolLabel(name: string): string {
  const view = DOMO_TOOLS[name]
  return view ? view.label({ name, args: {}, result: null }) : name.replace(/_/g, ' ')
}
