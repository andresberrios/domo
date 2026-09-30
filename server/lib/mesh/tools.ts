import { acpManager, normalizeCwd } from '../acp/manager'
import { listAdapterCatalog } from '../acp/models'
import { assertSessionStartable } from '../acp/startable'
import { applyAgentSessionPatch } from '../acp/session-settings'
import { transcriptPage, TRANSCRIPT_DIGEST_KINDS } from '../acp/transcript-digest'
import { describeSeed } from '../dev-env/workspace-seed'
import { pinnedAdapterVersions } from '../dev-env/runtime-volume'
import { inspectContainer, type ContainerInspection } from '../dev-env/docker'
import { DOOD_CONTAINER_LABEL } from '../dev-env/container'
import { startSubscriptionNotifier, watch } from '../acp/subscriptions'
import {
  beginEnvironment,
  cleanupEnvironment,
  environmentAdapterVersions,
  startEnvironment,
  stopEnvironment
} from '../dev-environments'
import { forwardEnvironmentPort, refreshEnvironmentPorts, unforwardEnvironmentPort } from '../dev-environment-ports'
import { createProjectFromPath, retireProjectCascade, retireProjectEnvironment } from '../projects'
import { normalizeCronJobInput } from '../cron/input'
import { notifyHuman } from '../notifications'
import { isThinkingAgent } from '../voice/delegation'
import {
  addAgentSubscription,
  appendAgentEvent,
  createCronJob,
  deleteCronJob,
  deleteInboxMessage,
  enqueueInboxMessage,
  finishCronRun,
  getAgentSession,
  getAgentSessionWithEnvironment,
  getCronJob,
  getDevEnvironment,
  getProject,
  isSpawnedBy,
  listAgentFollowers,
  listAgentSessions,
  listAgentSubscriptions,
  listCronJobs,
  listCronRuns,
  listDevEnvironments,
  listInboxMessages,
  listPermissions,
  listProjects,
  listUsageLimits,
  listUsageProviders,
  replaceCronJob,
  removeAgentSubscription,
  startManualCronRun,
  updateDevEnvironment,
  updateProject,
  voiceUserSpokeSince
} from '../repo'
import { sessionStartability } from '../../../shared/retention'
import type {
  AgentInboxMessage,
  AgentSession,
  AgentSessionStatus,
  CronJob,
  DevEnvironment,
  MessageDelivery
} from '../../../shared/types'
import { isAgentAdapter } from '../../../shared/agent-adapters'

const DELIVERIES: MessageDelivery[] = ['steer', 'queue', 'interrupt']
const STATUSES: AgentSessionStatus[] = ['idle', 'starting', 'thinking', 'awaiting-permission', 'error', 'stopped']
const ADAPTERS = ['claude-code', 'codex', 'opencode'] as const

/**
 * What every agent is told about the mesh when it connects (MCP `instructions`).
 * Agents working in other projects know nothing about Domo, so this and the
 * tool descriptions are the whole of their documentation.
 */
export const MESH_INSTRUCTIONS = [
  'Domo runs coding agents (Claude Code, Codex, OpenCode) for one human, who watches them in a web UI and may talk to a voice assistant.',
  'You are one of those agents. These tools are how you see and act on the rest of Domo.',
  'An agent session has an id (ag_…); most tools default to your own session when agentId is omitted.',
  'A project is a git checkout on the human\'s machine; a development environment (env_…) is an isolated container with its own copy of it. Agents run either on the host or inside an environment.',
  'You cannot wait for another agent: its turn ends long after yours. Use spawn_agent or subscribe_to_agent and Domo will message you when it finishes.',
  'To reach the human, use notify_supervisor: it stays in the UI until they have seen it.'
].join(' ')

/** One line of text, clipped. */
function clip(text: string | null | undefined, max: number): string {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** A positive whole number, or the fallback. */
function count(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = Math.floor(Number(value))
  return Number.isFinite(number) && number >= 1 ? Math.min(number, max) : fallback
}

function inboxText(message: AgentInboxMessage): string {
  return (message.content ?? [])
    .map((block: any) => block?.type === 'text' ? block.text : block?.type === 'resource_link' ? `[${block.name ?? block.uri}]` : '')
    .join(' ')
}

/**
 * How long a subscription lasts: a number of turn ends (default 1, "tell me
 * when this finishes"), or indefinitely.
 */
function subscriptionWindow(turns: unknown, indefinitely: unknown): number | null {
  return indefinitely === true ? null : count(turns, 1, 1000)
}

function describeWindow(remainingTurns: number | null): string | number {
  return remainingTurns === null ? 'indefinite' : remainingTurns
}

/**
 * Where a host session a caller spawns runs when it names no directory: the
 * caller's own, or, for a caller in an environment, whose directory exists
 * only in its container, that environment's project checkout.
 */
async function hostCwdFor(caller: AgentSession): Promise<string> {
  if (!caller.devEnvironmentId) return caller.cwd
  const environment = await getDevEnvironment(caller.devEnvironmentId)
  const project = environment ? await getProject(environment.projectId) : null
  if (!project) throw new Error('Pass cwd: an absolute path on the host for the new session.')
  return project.repoPath
}

/**
 * Record that `subscriber` wants to hear about `target`.
 *
 * Refuses the two shapes that are only ever a mistake: following yourself, and
 * closing a two-agent loop, where each finished turn is a message to the other
 * and every message is a turn. Nothing here walks the whole graph — a longer
 * cycle is possible and is the caller's business — but the pair that costs
 * nothing to make is worth catching.
 */
async function subscribe(subscriberId: string, targetId: string, remainingTurns: number | null): Promise<void> {
  if (subscriberId === targetId) throw new Error('An agent cannot subscribe to itself.')
  const theirs = await listAgentSubscriptions(targetId)
  if (theirs.some(entry => entry.targetId === subscriberId)) {
    throw new Error(
      `Agent ${targetId} already subscribes to this session. Two agents notifying each other would never stop.`
    )
  }
  // A subscription is a row, so it must never outlive the listener that acts
  // on it; starting here costs nothing and is idempotent.
  await startSubscriptionNotifier()
  await addAgentSubscription(subscriberId, targetId, remainingTurns)
  watch(targetId)
}

/**
 * Queue a note from Domo itself in an agent's inbox: delivered now if it is
 * idle, after its turn if it is busy. Best effort — the agent may have been
 * archived or retired in the meantime, and then there is nobody to tell.
 */
async function tellAgent(agentId: string, text: string): Promise<void> {
  try {
    await enqueueInboxMessage({ agentSessionId: agentId, content: [{ type: 'text', text }], delivery: 'queue', origin: 'system' })
    acpManager.drainInbox(agentId)
  } catch (error) {
    console.error(`[mesh] could not tell ${agentId}`, error)
  }
}

async function requireAgent(id: unknown): Promise<AgentSession> {
  const session = await getAgentSession(String(id ?? ''))
  if (!session) throw new Error(`No agent ${id}. Use list_agents to find ids.`)
  return session
}

async function requireEnvironment(id: unknown): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(String(id ?? ''))
  if (!environment) throw new Error(`No development environment ${id}. Use list_projects to find ids.`)
  return environment
}

/**
 * The cross-agent powers that could take a human out of the loop — answering
 * permission requests, running and editing another agent's schedule — are
 * limited to the agents the caller spawned, directly or through agents it
 * spawned. That edge is visible in the UI and on every session, so it can be
 * tightened later without a redesign.
 */
async function assertOwns(caller: AgentSession, target: AgentSession, doing: string): Promise<void> {
  if (target.id === caller.id) return
  if (await isSpawnedBy(target.id, caller.id)) return
  throw new Error(
    `Refusing ${doing}: agent "${target.title}" (${target.id}) was not spawned by you. `
    + 'You can only do this for your own session and agents you spawned; ask the human or the agent\'s owner.'
  )
}

/** The environment a tool acts on: the one named, or the caller's own. */
async function environmentFor(caller: AgentSession, id: unknown, parameter = 'environmentId'): Promise<DevEnvironment> {
  const environmentId = String(id ?? caller.devEnvironmentId ?? '')
  if (!environmentId) {
    throw new Error(`This agent is not running in a development environment; pass ${parameter} (from list_projects).`)
  }
  return requireEnvironment(environmentId)
}

function describeSettings(session: AgentSession) {
  return (session.configOptions ?? []).map(option => ({
    setting: option.name,
    id: option.id,
    value: session.config?.[option.id] ?? option.currentValue,
    options: option.options.map(entry => entry.value)
  }))
}

function describeUsage(session: AgentSession) {
  if (!session.usage) return null
  const { context, cost } = session.usage
  return {
    contextUsed: context.used,
    contextSize: context.size,
    contextPercent: context.size ? Math.round((context.used / context.size) * 100) : null,
    ...cost ? { cost: cost.amount, currency: cost.currency } : {},
    asOf: session.usage.updatedAt
  }
}

function describeJob(job: CronJob) {
  return {
    id: job.id,
    agentId: job.agentSessionId,
    name: job.name,
    prompt: job.prompt,
    schedule: job.scheduleType === 'cron' ? `${job.cronExpression} (${job.timezone})` : `once at ${job.runAt}`,
    enabled: job.enabled,
    delivery: job.delivery,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    lastStatus: job.lastStatus,
    ...job.lastError ? { lastError: job.lastError } : {},
    runCount: job.runCount,
    createdBy: job.createdBy
  }
}

/**
 * What `docker` means inside an environment: the host's daemon seen through
 * Domo's per-environment proxy (the default now), a private daemon of its own
 * (Docker-in-Docker, older environments or a project that asks for it), or
 * none at all.
 */
function dockerAccess(inspection: ContainerInspection): 'host' | 'own' | 'none' {
  if (inspection.labels[DOOD_CONTAINER_LABEL] === 'true') return 'host'
  if (inspection.namedVolumes.some(name => name.includes('dind-var-lib-docker'))) return 'own'
  return 'none'
}

const agentId = (description: string) => ({ type: 'string', description })
const environmentId = {
  type: 'string',
  description: 'Development environment id (env_…), from list_projects. Defaults to the one you run in.'
}

/**
 * The agent mesh: what a coding agent can do to the rest of Domo.
 *
 * Every session Domo spawns gets these tools through the built-in `domo`
 * MCP server (`server/api/internal/mcp.ts`). The descriptions are the only
 * documentation an agent working in another project ever sees.
 */
export const MESH_TOOLS = [
  // ---------------------------------------------------------------- agents
  {
    name: 'list_models',
    description:
      'List the coding-agent harnesses (claude-code, codex, opencode), the models each offers and its permission '
      + 'modes. Call before spawn_agent or manage_agent_session with a model or modeId, so you pass a real id.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: { type: 'string', enum: [...ADAPTERS], description: 'Only this harness. Omit for all of them.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_agents',
    description:
      'List other agent sessions, most recently active first, with status (thinking = mid-turn, '
      + 'awaiting-permission = blocked on a decision), environment, model and a short summary of their latest output. '
      + 'Hides archived sessions and ones that can no longer run (their environment was retired) unless asked. '
      + 'Your own session is not listed; get_agent describes it.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: { type: 'string', enum: STATUSES },
          description: 'Only agents in one of these states. ["thinking", "awaiting-permission"] is "who is working right now".'
        },
        environmentId: { type: 'string', description: 'Only agents in this development environment.' },
        projectId: { type: 'string', description: 'Only agents in environments of this project.' },
        spawnedByMe: { type: 'boolean', description: 'Only agents you spawned, directly or through agents you spawned.' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
        includeUnstartable: {
          type: 'boolean',
          description: 'Include sessions that can no longer run because their environment was retired. Their transcripts are still readable. Default false.'
        },
        limit: { type: 'number', description: 'At most this many. Default 30.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_agent',
    description:
      'Everything about one agent session: status, model, mode and the modes it can switch to, adapter settings, '
      + 'context-window use and cost, last error, its pending permission requests (with option ids), the messages '
      + 'queued in its inbox, and who spawned it. Defaults to your own session.',
    inputSchema: {
      type: 'object',
      properties: { agentId: agentId('Agent session id. Defaults to your own session.') },
      additionalProperties: false
    }
  },
  {
    name: 'read_agent_transcript',
    description:
      'Read an agent session\'s transcript as condensed items (messages, thoughts, tool calls, plans, notices), newest '
      + 'page first. Each item has a seq; page back with olderBeforeSeq, or read from the start with afterSeq: 0 and '
      + 'follow newerAfterSeq. Works on your own session and on sessions that can no longer run.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: agentId('Agent session id. Defaults to your own session.'),
        limit: { type: 'number', description: 'Items per page. Default 20, maximum 100.' },
        beforeSeq: { type: 'number', description: 'Return the items before this seq (the olderBeforeSeq of the previous page).' },
        afterSeq: { type: 'number', description: 'Return the items after this seq, oldest first. 0 starts at the beginning.' },
        include: {
          type: 'array',
          items: { type: 'string', enum: [...TRANSCRIPT_DIGEST_KINDS] },
          description: 'Kinds to include. Default all.'
        },
        maxChars: { type: 'number', description: 'Longest message text to return, in characters. Default 4000, maximum 20000.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'message_agent',
    description:
      'Send a message (a prompt) to another agent session; it becomes that agent\'s next turn. Also how you start a '
      + 'stopped agent, or test one by hand. Nothing is lost if it is busy.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: agentId('Target agent session id.'),
        message: { type: 'string', description: 'What to tell that agent.' },
        delivery: {
          type: 'string',
          enum: DELIVERIES,
          description:
            'When the agent is busy: "queue" (default) waits for its current turn to end; "steer" injects the message '
            + 'into the running turn (agents that cannot be steered are interrupted instead); "interrupt" cancels the '
            + 'turn first. An idle agent starts on it immediately either way.'
        }
      },
      required: ['agentId', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'cancel_agent_turn',
    description:
      'Stop the turn another agent is running, without sending it anything. Its conversation is kept, and messages '
      + 'queued in its inbox are then delivered as its next turn (withdraw them first with withdraw_queued_message if '
      + 'you do not want that).',
    inputSchema: {
      type: 'object',
      properties: { agentId: agentId('Agent session id.') },
      required: ['agentId'],
      additionalProperties: false
    }
  },
  {
    name: 'withdraw_queued_message',
    description:
      'Take back a message still waiting in an agent\'s inbox (get_agent lists them as queuedMessages). Allowed for '
      + 'messages you sent, and for any message queued for yourself or an agent you spawned.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: agentId('The agent whose inbox holds the message.'),
        messageId: { type: 'string', description: 'Queued message id from get_agent.' }
      },
      required: ['agentId', 'messageId'],
      additionalProperties: false
    }
  },
  {
    name: 'answer_permission_request',
    description:
      'Answer a permission request an agent is blocked on (get_agent lists them, with option ids). Only for agents you '
      + 'spawned; anything else is the human\'s decision. As the thinking agent of a voice conversation, only once the '
      + 'human there has decided, and then for any agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: agentId('The agent that asked.'),
        permissionId: { type: 'string', description: 'Permission request id (pm_…).' },
        optionId: { type: 'string', description: 'The optionId to choose, e.g. an allow_once option.' },
        reject: { type: 'boolean', description: 'Cancel the request without choosing an option, instead of passing optionId.' }
      },
      required: ['agentId', 'permissionId'],
      additionalProperties: false
    }
  },
  {
    name: 'spawn_agent',
    description:
      'Start a new agent session on a task and return its id. Use it to parallelise independent work. By default you '
      + 'are messaged when its first turn ends (see notifyWhenDone).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the new session.' },
        prompt: { type: 'string', description: 'The task to hand to the new agent.' },
        adapter: {
          type: 'string',
          enum: [...ADAPTERS],
          description: 'Which harness runs it. Defaults to your own.'
        },
        model: { type: 'string', description: 'Model id from list_models, for that harness. Omit for its default.' },
        modeId: {
          type: 'string',
          description: 'Permission mode id from list_models, for that harness (e.g. how freely it may edit and run commands). Omit for the default.'
        },
        devEnvironmentId: {
          type: ['string', 'null'],
          description: 'The development environment to run the new agent in, from list_projects; it must be running. '
            + 'Omit it, or pass null, for a session on the host, even when you are in an environment yourself. '
            + 'Your own environment\'s id is in $DOMO_DEV_ENVIRONMENT_ID.'
        },
        cwd: {
          type: 'string',
          description: 'Absolute working directory on the host, for a host session. Defaults to yours when you are on '
            + 'the host, and to your environment\'s project checkout when you are in a development environment. '
            + 'Ignored with devEnvironmentId.'
        },
        notifyWhenDone: {
          type: 'boolean',
          description: 'Be messaged when it finishes a turn, and when it needs a permission or fails. Default true. Set false for work you will not follow up.'
        },
        notifyTurns: { type: 'number', description: 'How many turn ends to be told about. Default 1 (its first turn).' },
        notifyIndefinitely: {
          type: 'boolean',
          description: 'Be told about every turn until you unsubscribe. Use deliberately, and call unsubscribe_from_agent when you no longer need updates.'
        }
      },
      required: ['title', 'prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'manage_agent_session',
    description:
      'Change an agent session: rename it, change its permission mode or model, change one of the harness\'s own '
      + 'settings (e.g. reasoning effort; get_agent lists them), or archive/unarchive it. Defaults to your own session. '
      + 'Pass only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: agentId('Agent session id. Defaults to your own session.'),
        title: { type: 'string', description: 'New title.' },
        modeId: { type: 'string', description: 'Mode id from get_agent or list_models.' },
        model: { type: 'string', description: 'Model id from list_models.' },
        setting: { type: 'string', description: 'A setting name or id from get_agent, e.g. "reasoning effort".' },
        settingValue: { type: 'string', description: 'The value for setting, e.g. "high".' },
        archived: {
          type: 'boolean',
          description: 'true stops the session, hides it from lists and drops its subscriptions; false brings it back. Refused on your own session.'
        }
      },
      additionalProperties: false
    }
  },

  // ---------------------------------------------------------------- subscriptions
  {
    name: 'subscribe_to_agent',
    description:
      'Be messaged when another agent finishes a turn, with its latest output. Lasts one turn end by default ("tell me '
      + 'when this is done"). While it lasts you are also told when it needs a permission or fails; those do not use '
      + 'up turns. Subscribing again replaces the window.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: agentId('Agent session id to follow.'),
        turns: { type: 'number', description: 'How many turn ends to be told about. Default 1.' },
        indefinitely: {
          type: 'boolean',
          description: 'Be told about every turn until you unsubscribe. Use deliberately: call unsubscribe_from_agent as soon as you no longer need the updates.'
        }
      },
      required: ['agentId'],
      additionalProperties: false
    }
  },
  {
    name: 'unsubscribe_from_agent',
    description: 'Stop being told what another agent is doing.',
    inputSchema: {
      type: 'object',
      properties: { agentId: agentId('Agent session id to stop following.') },
      required: ['agentId'],
      additionalProperties: false
    }
  },
  {
    name: 'list_subscriptions',
    description: 'List the agents you are subscribed to (with turns left, or "indefinite") and the agents subscribed to you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },

  // ---------------------------------------------------------------- projects and environments
  {
    name: 'list_projects',
    description: 'List projects (git checkouts on the host) and their development environments, with ids and status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_project',
    description: 'Add a project backed by a local git checkout on the host, so development environments can be created from it.',
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'Absolute path to a git checkout on the host.' },
        name: { type: 'string', description: 'Display name. Defaults to the directory name.' }
      },
      required: ['repoPath'],
      additionalProperties: false
    }
  },
  {
    name: 'update_project',
    description: 'Rename a project.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id, from list_projects.' },
        name: { type: 'string', description: 'New name.' }
      },
      required: ['projectId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'retire_project',
    description:
      'Retire a project and every one of its development environments: their containers and worktrees are '
      + 'destroyed, and each branch Domo made for one is deleted if fully merged. The records are kept — the project, the environments and the full transcript of '
      + 'every coding agent that ran in them stay readable — but those agents can never be started again, and '
      + 'nothing inside a container can be brought back.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project id, from list_projects.' } },
      required: ['projectId'],
      additionalProperties: false
    }
  },
  {
    name: 'create_dev_environment',
    description:
      'Create a new isolated development environment for a project: a container with its own git worktree of the '
      + 'repository, on a branch whose name is the environment\'s, verbatim, made from the project\'s last commit. If a '
      + 'branch of that name already exists it is checked out instead, with its commits, and the message saying it '
      + 'is running says so: tell the user, since it may not be what they meant. Uncommitted work on the host stays there; gitignored '
      + '`.env` files are copied. Returns at once with status "creating"; building takes minutes. You are messaged '
      + 'when it is running or has failed, and get_dev_environment shows status and lastError at any time.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id, from list_projects.' },
        name: {
          type: 'string',
          description: 'The environment\'s name and its branch, exactly as given, e.g. "feature-auth" or "handoff/speech". '
            + 'Any name git allows for a branch; slashes group environments in the UI.'
        },
        notifyWhenReady: { type: 'boolean', description: 'Message you when it is running or has failed. Default true.' }
      },
      required: ['projectId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'get_dev_environment',
    description:
      'Details of a development environment: status (creating, running, stopped, error), lastError, workspace path, '
      + 'the adapter versions it runs against the ones Domo installs today, what `docker` reaches from inside it '
      + '(host: the host\'s daemon, shared; own: a private daemon; none), any Docker resources a cleanup could not '
      + 'remove, the branch it was made on, and the agents in it.',
    inputSchema: {
      type: 'object',
      properties: { environmentId },
      additionalProperties: false
    }
  },
  {
    name: 'update_dev_environment',
    description: 'Start or stop a development environment\'s container, and/or rename it. Agents in a stopped environment cannot run.',
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: { type: 'string', description: 'Environment id, from list_projects.' },
        status: { type: 'string', enum: ['running', 'stopped'], description: 'Start ("running") or stop ("stopped") the container.' },
        name: { type: 'string', description: 'New name.' }
      },
      required: ['environmentId'],
      additionalProperties: false
    }
  },
  {
    name: 'retire_dev_environment',
    description:
      'Retire a development environment: its container and its worktree are destroyed, so uncommitted work in it '
      + 'is lost, and a build under way is stopped. Commits stay in the project\'s repository. The branch Domo made for it is deleted if every commit '
      + 'on it is also on another branch, and kept otherwise; the result says which. The records are kept — the '
      + 'environment and the full transcript of every coding agent that ran in it stay readable — but those agents '
      + 'can never be started again.',
    inputSchema: {
      type: 'object',
      properties: { environmentId: { type: 'string', description: 'Environment id, from list_projects.' } },
      required: ['environmentId'],
      additionalProperties: false
    }
  },
  {
    name: 'retry_environment_cleanup',
    description:
      'Try again to remove the Docker resources a retirement could not. Domo never retries on a timer: a refused '
      + 'removal names the container that is in the way, and this is what you call once you have removed it. '
      + 'Answers with what went and what is still blocked.',
    inputSchema: {
      type: 'object',
      properties: { environmentId: { type: 'string', description: 'Environment id, from list_projects.' } },
      required: ['environmentId'],
      additionalProperties: false
    }
  },
  {
    name: 'list_environment_ports',
    description:
      'List the TCP ports listening in a development environment and in the containers it started with docker (each '
      + 'named by its service), and for each forwarded one the URL the human can open on their machine.',
    inputSchema: {
      type: 'object',
      properties: { environmentId },
      additionalProperties: false
    }
  },
  {
    name: 'forward_environment_port',
    description:
      'Make a port listening inside a development environment (a dev server, say) reachable from the human\'s machine, '
      + 'and return its URL to give them. forward: false stops forwarding it.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'The port inside the environment, or inside the service.' },
        service: {
          type: 'string',
          description: 'The container the port is in, when it is one the environment started (list_environment_ports names it). Omit for the environment itself.'
        },
        forward: { type: 'boolean', description: 'false stops forwarding. Default true.' },
        environmentId
      },
      required: ['port'],
      additionalProperties: false
    }
  },

  // ---------------------------------------------------------------- scheduled tasks
  {
    name: 'schedule_task',
    description:
      'Schedule a prompt to be delivered to an agent later: recurring (cronExpression) or once (runAt). Durable across '
      + 'restarts. For yourself by default, or for an agent you spawned.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short label.' },
        prompt: { type: 'string', description: 'The full instruction to deliver when it fires.' },
        cronExpression: { type: 'string', description: 'Five-field cron expression, e.g. "0 9 * * 1-5".' },
        runAt: { type: 'string', description: 'ISO 8601 date and time, for a one-time task.' },
        timezone: { type: 'string', description: 'IANA zone for cronExpression. Default UTC.' },
        delivery: {
          type: 'string', enum: DELIVERIES,
          description: 'If the agent is busy when it fires. Default "queue" (after its current turn).'
        },
        agentId: agentId('Agent to deliver it to. Defaults to your own session.')
      },
      required: ['name', 'prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'list_scheduled_tasks',
    description:
      'List an agent\'s scheduled tasks with their next and last runs. Pass jobId for one task and its recent run '
      + 'history (when each fired, and whether delivery failed).',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: agentId('Whose tasks. Defaults to your own session.'),
        jobId: { type: 'string', description: 'One task, with its run history.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'update_scheduled_task',
    description: 'Edit, pause or resume a scheduled task of yours or of an agent you spawned. Pass only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Task id from list_scheduled_tasks.' },
        name: { type: 'string' },
        prompt: { type: 'string' },
        cronExpression: { type: 'string', description: 'Switch to or replace a recurring schedule.' },
        runAt: { type: 'string', description: 'Switch to or replace a one-time ISO 8601 run.' },
        timezone: { type: 'string' },
        delivery: { type: 'string', enum: DELIVERIES },
        enabled: { type: 'boolean', description: 'false pauses the task; true resumes it.' }
      },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'run_scheduled_task',
    description:
      'Deliver a scheduled task\'s prompt now, exactly as the schedule would, to test it. The schedule is unchanged and '
      + 'the run appears in its history. For your own tasks and those of agents you spawned.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Task id from list_scheduled_tasks.' } },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_scheduled_task',
    description: 'Permanently delete a scheduled task of yours or of an agent you spawned.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Task id from list_scheduled_tasks.' } },
      required: ['jobId'],
      additionalProperties: false
    }
  },

  // ---------------------------------------------------------------- the human
  {
    name: 'notify_supervisor',
    description:
      'Tell the human something: a result, a blocker, a question that needs their decision. It appears in Domo\'s '
      + 'notifications panel and stays until they have seen it, and is spoken if they are in a voice conversation. '
      + 'Attach files (screenshots, logs, reports) by path.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to tell them. Self-contained: they may read it hours later.' },
        urgent: { type: 'boolean', description: 'They should be interrupted now.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths of files to attach, as you see them (relative to your working directory is fine). At most 5, 10 MB each.'
        }
      },
      required: ['message'],
      additionalProperties: false
    }
  },
  {
    name: 'get_usage_limits',
    description:
      'How much of the human\'s Claude, Codex and OpenCode plan limits is used, and when each window resets. Check '
      + 'before starting a lot of work on one harness.',
    inputSchema: {
      type: 'object',
      properties: { provider: { type: 'string', enum: ['claude', 'codex', 'opencode'], description: 'Only this account.' } },
      additionalProperties: false
    }
  }
] as const

/**
 * Run one mesh tool on behalf of a caller the transport has already
 * authenticated — the caller is never taken from the request body.
 */
export async function callMeshTool(callerSessionId: string, tool: string, input: unknown): Promise<unknown> {
  const caller = await getAgentSession(callerSessionId)
  if (!caller) throw new Error(`No agent ${callerSessionId}`)
  // A token belonging to a session that can no longer run is still a valid
  // token for as long as the dying adapter holds it. Nothing it asks for may
  // act as a working agent.
  const callerEnvironment = caller.devEnvironmentId ? await getDevEnvironment(caller.devEnvironmentId) : null
  assertSessionStartable(caller, callerEnvironment, null, 'acting as it on the mesh')
  const args = (input ?? {}) as any

  switch (tool) {
    case 'list_models':
      // The same cached probe the picker uses; there is no second spawn path.
      return listAdapterCatalog(isAgentAdapter(args.adapter) ? args.adapter : undefined)

    case 'list_agents': {
      const [sessions, environments] = await Promise.all([
        listAgentSessions(args.includeArchived === true),
        listDevEnvironments(undefined, true)
      ])
      const environmentOf = (session: AgentSession) =>
        environments.find(environment => environment.id === session.devEnvironmentId) ?? null
      const statuses = Array.isArray(args.status) ? new Set<string>(args.status) : null
      const limit = count(args.limit, 30, 200)
      const listed: unknown[] = []
      for (const session of sessions) {
        if (session.id === caller.id) continue
        if (statuses && !statuses.has(session.status)) continue
        if (args.environmentId && session.devEnvironmentId !== args.environmentId) continue
        const environment = environmentOf(session)
        if (args.projectId && environment?.projectId !== args.projectId) continue
        // A peer whose environment has been retired is still a record worth
        // reading, but it is most of the list on a long-lived install and
        // nothing can be handed to it, so it is shown only when asked for.
        const state = sessionStartability(session, environment)
        if (!state.startable && args.includeUnstartable !== true) continue
        if (args.spawnedByMe === true && !(await isSpawnedBy(session.id, caller.id))) continue
        listed.push({
          id: session.id,
          title: session.title,
          adapter: session.adapter,
          status: session.status,
          model: session.model,
          mode: session.modeId,
          ...session.devEnvironmentId ? { environmentId: session.devEnvironmentId } : { cwd: session.cwd },
          lastActivityAt: session.lastActivityAt ?? session.createdAt,
          ...session.spawnedBy ? { spawnedBy: session.spawnedBy } : {},
          ...session.archived ? { archived: true } : {},
          ...state.startable ? {} : { startable: false },
          summary: clip(session.summary, 200)
        })
        if (listed.length >= limit) break
      }
      return { agents: listed, ...listed.length >= limit ? { note: `First ${limit}; pass limit or a filter for more.` } : {} }
    }

    case 'get_agent': {
      const { session: target, environment } = await getAgentSessionWithEnvironment(String(args.agentId ?? caller.id))
      if (!target) throw new Error(`No agent ${args.agentId}. Use list_agents to find ids.`)
      const state = sessionStartability(target, environment)
      const [permissions, inbox] = await Promise.all([
        listPermissions(target.id, true),
        listInboxMessages(target.id, true)
      ])
      return {
        id: target.id,
        title: target.title,
        ...target.id === caller.id ? { you: true } : {},
        adapter: target.adapter,
        status: target.status,
        model: target.model,
        mode: target.modeId,
        modes: (target.modes ?? []).map(mode => mode.id),
        settings: describeSettings(target),
        cwd: target.cwd,
        environmentId: target.devEnvironmentId,
        ...environment ? { projectId: environment.projectId } : {},
        startable: state.startable,
        ...state.startable ? {} : { cannotStart: state.reason },
        archived: target.archived,
        spawnedBy: target.spawnedBy,
        createdAt: target.createdAt,
        lastActivityAt: target.lastActivityAt,
        lastError: target.lastError,
        usage: describeUsage(target),
        pendingPermissions: permissions.map(permission => ({
          id: permission.id,
          title: permission.title,
          options: permission.options,
          createdAt: permission.createdAt
        })),
        queuedMessages: inbox.map(message => ({
          id: message.id,
          from: message.origin,
          delivery: message.delivery,
          text: clip(inboxText(message), 300),
          createdAt: message.createdAt
        })),
        summary: clip(target.summary, 600)
      }
    }

    case 'read_agent_transcript': {
      const target = await requireAgent(args.agentId ?? caller.id)
      const page = await transcriptPage(target.id, {
        limit: args.limit,
        include: args.include,
        // A peer reading a report needs the report, not the spoken-size clip.
        messageChars: count(args.maxChars, 4000, 20_000),
        beforeSeq: typeof args.beforeSeq === 'number' ? args.beforeSeq : undefined,
        afterSeq: typeof args.afterSeq === 'number' ? args.afterSeq : undefined
      })
      return { agentId: target.id, title: target.title, status: target.status, ...page }
    }

    case 'message_agent': {
      const messaged = await getAgentSessionWithEnvironment(args.agentId)
      const target = messaged.session
      if (!target) throw new Error(`No agent ${args.agentId}. Use list_agents to find ids.`)
      assertSessionStartable(target, messaged.environment, null, 'messaging it')
      const from = caller.title
      // An agent writing to a peer has no idea what that peer is in the middle
      // of, so the default waits rather than cutting across it.
      const delivery = DELIVERIES.find(mode => mode === args.delivery) ?? 'queue'
      const result = await acpManager.deliver(target.id, {
        content: [{ type: 'text', text: `[Message from agent "${from}" (${caller.id})]\n\n${args.message}` }],
        delivery,
        origin: `agent:${caller.id}`
      })
      await appendAgentEvent(target.id, 'mesh_inbound', {
        from: caller.id, fromTitle: from, message: args.message, delivery: result.delivery
      })
      await appendAgentEvent(caller.id, 'mesh_outbound', {
        to: target.id, toTitle: target.title, message: args.message, delivery: result.delivery
      })
      return {
        delivered: true,
        agentId: target.id,
        title: target.title,
        delivery: result.delivery,
        outcome: result.outcome
      }
    }

    case 'cancel_agent_turn': {
      const target = await requireAgent(args.agentId)
      // Cancelling the turn that is running this very tool call would leave
      // its answer undelivered.
      if (target.id === caller.id) throw new Error('Refusing to cancel your own turn from inside it; just end your turn.')
      if (!acpManager.isBusy(target.id)) {
        return { agentId: target.id, title: target.title, cancelled: false, note: `It is not running a turn (status ${target.status}).` }
      }
      await acpManager.cancel(target.id)
      return { agentId: target.id, title: target.title, cancelled: true }
    }

    case 'withdraw_queued_message': {
      const target = await requireAgent(args.agentId)
      const waiting = (await listInboxMessages(target.id, true)).find(message => message.id === args.messageId)
      if (!waiting) throw new Error(`No message ${args.messageId} is waiting in that agent's inbox; it may already have been delivered.`)
      if (waiting.origin !== `agent:${caller.id}`) await assertOwns(caller, target, 'withdrawing a message someone else sent')
      const removed = await deleteInboxMessage(waiting.id)
      if (!removed) throw new Error('That message was delivered before it could be withdrawn.')
      return { agentId: target.id, messageId: waiting.id, withdrawn: true }
    }

    case 'answer_permission_request': {
      const target = await requireAgent(args.agentId)
      if (target.id === caller.id) throw new Error('An agent cannot answer its own permission requests.')
      // A conversation's thinking agent is the hands of a human who is listening
      // and hears every request (the voice runtime says each one). It answers
      // what they decided, for any agent, as the voice agent's own tool does;
      // and only once they have spoken since the request, never on its own.
      const voiceSessionId = caller.voiceSessionId && await isThinkingAgent(caller) ? caller.voiceSessionId : null
      if (!voiceSessionId) await assertOwns(caller, target, 'answering its permission request')
      const permission = (await listPermissions(target.id, true)).find(entry => entry.id === args.permissionId)
      if (!permission) throw new Error(`No pending permission request ${args.permissionId} for that agent; it may already have been answered.`)
      if (voiceSessionId && !(await voiceUserSpokeSince(voiceSessionId, permission.createdAt))) {
        throw new Error(
          'The human in your voice conversation has not answered this request yet. Put it in your answer (what the '
          + 'agent wants to do, and the options) and answer it once they have decided.'
        )
      }
      const optionId = args.reject === true ? null : String(args.optionId ?? '')
      if (optionId === '') throw new Error('Pass optionId, or reject: true.')
      if (optionId !== null && !permission.options.some(option => option.optionId === optionId)) {
        throw new Error(`No option ${optionId}. Options: ${permission.options.map(option => `${option.optionId} (${option.name})`).join(', ')}.`)
      }
      await acpManager.answerPermission(target.id, permission.id, optionId, voiceSessionId ? 'voice-agent' : `agent:${caller.id}`)
      await appendAgentEvent(caller.id, 'mesh_permission_answered', {
        agentId: target.id, title: target.title, permissionId: permission.id, request: permission.title, optionId
      })
      return { agentId: target.id, permissionId: permission.id, answered: true, optionId }
    }

    case 'spawn_agent': {
      // Only where it was asked for: an omitted id is the host, wherever the caller runs.
      const devEnvironmentId: string | null = args.devEnvironmentId || null
      if (devEnvironmentId) {
        const environment = await requireEnvironment(devEnvironmentId)
        if (environment.status !== 'running') {
          throw new Error(`Development environment "${environment.name}" is ${environment.status}; start it with update_dev_environment first.`)
        }
      }
      if (args.adapter !== undefined && !isAgentAdapter(args.adapter)) {
        throw new Error(`Unknown adapter ${args.adapter}; use one of ${ADAPTERS.join(', ')}.`)
      }
      const session = await acpManager.create({
        adapter: isAgentAdapter(args.adapter) ? args.adapter : caller.adapter,
        title: args.title,
        cwd: devEnvironmentId ? undefined : (args.cwd ? normalizeCwd(args.cwd) : await hostCwdFor(caller)),
        devEnvironmentId,
        voiceSessionId: caller.voiceSessionId ?? null,
        model: args.model ?? null,
        modeId: args.modeId ?? null,
        initialPrompt: args.prompt,
        spawnedBy: caller.id
      })
      // The caller is an agent by definition here, and an agent cannot wait for
      // its peer — so following it is the default, not the opt-in.
      const notify = args.notifyWhenDone !== false
      const window = subscriptionWindow(args.notifyTurns, args.notifyIndefinitely)
      if (notify) await subscribe(caller.id, session.id, window)
      await appendAgentEvent(caller.id, 'mesh_spawned', {
        agentId: session.id, title: session.title, notifyWhenDone: notify
      })
      return {
        id: session.id,
        title: session.title,
        adapter: session.adapter,
        status: session.status,
        ...session.lastError ? { lastError: session.lastError } : {},
        cwd: session.cwd,
        model: session.model,
        mode: session.modeId,
        notifyWhenDone: notify ? describeWindow(window) : false
      }
    }

    case 'manage_agent_session': {
      const target = await requireAgent(args.agentId ?? caller.id)
      // Same hazard as `retire_dev_environment`: stopping the adapter process
      // handling this very tool call would leave its own response undelivered.
      if (args.archived && target.id === caller.id) {
        throw new Error('Refusing to archive the session this agent is running in. Ask the user or another agent to do it.')
      }
      const managedEnvironment = target.devEnvironmentId
        ? await getDevEnvironment(target.devEnvironmentId)
        : null
      assertSessionStartable(target, managedEnvironment, null, 'changing its settings')
      return applyAgentSessionPatch(target, {
        ...args,
        config: args.setting && args.settingValue ? { [args.setting]: args.settingValue } : undefined
      })
    }

    case 'subscribe_to_agent': {
      const followed = await getAgentSessionWithEnvironment(args.agentId)
      const target = followed.session
      if (!target) throw new Error(`No agent ${args.agentId}. Use list_agents to find ids.`)
      // An agent that can no longer start has no turn left to finish, so a
      // subscription to it would be a row that can never fire.
      assertSessionStartable(target, followed.environment, null, 'subscribing to it')
      const window = subscriptionWindow(args.turns, args.indefinitely)
      await subscribe(caller.id, target.id, window)
      return { subscribed: true, agentId: target.id, title: target.title, turns: describeWindow(window) }
    }

    case 'unsubscribe_from_agent': {
      const removed = await removeAgentSubscription(caller.id, args.agentId)
      return { subscribed: false, agentId: args.agentId, wasSubscribed: removed }
    }

    case 'list_subscriptions': {
      const [following, followers] = await Promise.all([listAgentSubscriptions(caller.id), listAgentFollowers(caller.id)])
      const titles = new Map((await listAgentSessions(true)).map(session => [session.id, session]))
      const describe = (id: string, remainingTurns: number | null, since: string) => ({
        agentId: id,
        title: titles.get(id)?.title ?? null,
        status: titles.get(id)?.status ?? null,
        turns: describeWindow(remainingTurns),
        since
      })
      return {
        following: following.map(entry => describe(entry.targetId, entry.remainingTurns, entry.createdAt)),
        followers: followers.map(entry => describe(entry.subscriberId, entry.remainingTurns, entry.createdAt))
      }
    }

    case 'list_projects': {
      const [projects, environments] = await Promise.all([listProjects(), listDevEnvironments()])
      return {
        projects: projects.map(project => ({
          id: project.id,
          name: project.name,
          repoPath: project.repoPath,
          environments: environments
            .filter(environment => environment.projectId === project.id)
            .map(environment => ({
              id: environment.id,
              name: environment.name,
              status: environment.status,
              ...environment.id === caller.devEnvironmentId ? { yours: true } : {}
            }))
        }))
      }
    }

    case 'create_project': {
      const project = await createProjectFromPath({ name: args.name, repoPath: args.repoPath })
      return { id: project.id, name: project.name, repoPath: project.repoPath }
    }

    case 'update_project': {
      const name = String(args.name ?? '').trim()
      if (!name) throw new Error('A name is required.')
      const updated = await updateProject(args.projectId, { name })
      if (!updated) throw new Error(`No project ${args.projectId}`)
      return { id: updated.id, name: updated.name }
    }

    case 'retire_project': {
      const environments = await listDevEnvironments(args.projectId)
      if (caller.devEnvironmentId && environments.some(environment => environment.id === caller.devEnvironmentId)) {
        throw new Error('Refusing to retire the project this agent session is running in. Ask the user or another agent to do it.')
      }
      const { leftovers } = await retireProjectCascade(args.projectId)
      return { id: args.projectId, retired: true, leftovers }
    }

    case 'create_dev_environment': {
      const { environment, built } = await beginEnvironment({
        projectId: args.projectId,
        name: String(args.name ?? '')
      })
      // Building takes minutes, far past any tool call's patience, so the call
      // answers with the row and the result arrives as a note.
      if (args.notifyWhenReady !== false) {
        built.then(
          ready => tellAgent(
            caller.id,
            `Development environment "${ready.name}" (${ready.id}) is running at ${ready.workspacePath}. `
            + describeSeed(ready.workspaceSeed)
          ),
          error => tellAgent(
            caller.id,
            `Development environment "${environment.name}" (${environment.id}) failed to build: `
            + `${error instanceof Error ? error.message : String(error)}`
          )
        )
      }
      return {
        id: environment.id,
        name: environment.name,
        status: environment.status,
        workspace: environment.workspacePath,
        note: args.notifyWhenReady === false
          ? 'Building; call get_dev_environment to see when it is running.'
          : 'Building; you will be messaged when it is running or has failed.'
      }
    }

    case 'get_dev_environment': {
      const environment = await environmentFor(caller, args.environmentId)
      const [project, versions, inspection, sessions] = await Promise.all([
        getProject(environment.projectId),
        environmentAdapterVersions(environment),
        environment.retiredAt ? null : inspectContainer(environment.containerId || environment.containerName).catch(() => null),
        listAgentSessions(true)
      ])
      const pinned = pinnedAdapterVersions()
      return {
        id: environment.id,
        name: environment.name,
        project: project ? { id: project.id, name: project.name, repoPath: project.repoPath } : environment.projectId,
        status: environment.retiredAt ? 'retired' : environment.status,
        ...environment.status === 'running' && inspection && !inspection.running
          ? { note: 'The container is not actually running; start it with update_dev_environment.' }
          : {},
        lastError: environment.lastError,
        workspace: environment.workspacePath,
        createdAt: environment.createdAt,
        ...environment.retiredAt ? { retiredAt: environment.retiredAt } : {},
        adapterVersions: versions ?? 'unknown until the environment is running',
        domoAdapterVersions: pinned,
        adaptersCurrent: versions
          ? Object.entries(pinned).every(([adapter, version]) => versions[adapter as keyof typeof versions] === version)
          : null,
        ...inspection ? { docker: dockerAccess(inspection) } : {},
        // Resources a retirement or a failed creation could not remove; empty
        // is done. retry_environment_cleanup is the second ask.
        ...environment.leftovers.length
          ? { leftovers: environment.leftovers.map(({ kind, name, error }) => ({ resource: `${kind} ${name}`, error })) }
          : {},
        ...environment.branch ? { branch: environment.branch, branchCreated: environment.branchCreated } : {},
        agents: sessions
          .filter(session => session.devEnvironmentId === environment.id && !session.archived)
          .map(session => ({ id: session.id, title: session.title, status: session.status }))
      }
    }

    case 'update_dev_environment': {
      let current = await requireEnvironment(args.environmentId)
      if (args.status === 'stopped' && current.id === caller.devEnvironmentId) {
        throw new Error('Refusing to stop the environment this agent is running in; it would stop you mid-call.')
      }
      if (args.status === 'running') current = await startEnvironment(current.id)
      else if (args.status === 'stopped') current = await stopEnvironment(current.id)
      const name = String(args.name ?? '').trim()
      if (name) current = (await updateDevEnvironment(current.id, { name })) ?? current
      return { id: current.id, name: current.name, status: current.status }
    }

    case 'retire_dev_environment': {
      if (caller.devEnvironmentId === args.environmentId) {
        throw new Error('Refusing to retire the environment this agent session is running in. Ask the user or another agent to do it.')
      }
      const retirement = await retireProjectEnvironment(args.environmentId)
      return {
        id: args.environmentId,
        retired: true,
        // Named rather than counted: the caller may well have been talking to
        // one of them a moment ago, and it is still readable.
        sessionsStoodDown: retirement.sessions.map(session => ({ id: session.id, title: session.title })),
        // Empty unless Docker refused something. Nothing retries it: each names
        // what is in the way, and retry_environment_cleanup is the second ask.
        leftovers: retirement.leftovers,
        branch: retirement.branch
      }
    }

    case 'retry_environment_cleanup': {
      const report = await cleanupEnvironment(args.environmentId)
      return {
        id: args.environmentId,
        removed: report.removed.map(leftover => `${leftover.kind} ${leftover.name}`),
        // Each carries the container that is in the way and the command that
        // deals with it, so the caller can do exactly that and call again.
        leftovers: report.leftovers.map(({ kind, name, error }) => ({ resource: `${kind} ${name}`, error }))
      }
    }

    case 'list_environment_ports': {
      const environment = await environmentFor(caller, args.environmentId)
      const ports = await refreshEnvironmentPorts(environment.id)
      return {
        environmentId: environment.id,
        ports: ports.filter(port => port.protocol === 'tcp').map(port => ({
          ...port.service ? { service: port.service } : {},
          port: port.innerPort,
          ...port.label ? { label: port.label } : {},
          listening: port.listening,
          forwarded: port.forwarded,
          ...port.url ? { url: port.url } : {}
        }))
      }
    }

    case 'forward_environment_port': {
      const environment = await environmentFor(caller, args.environmentId)
      const port = Number(args.port)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('port must be a TCP port number.')
      const service = typeof args.service === 'string' && args.service.trim() ? args.service.trim() : null
      if (args.forward === false) {
        await unforwardEnvironmentPort(environment.id, port, service)
        return { environmentId: environment.id, ...service ? { service } : {}, port, forwarded: false }
      }
      const forwarded = await forwardEnvironmentPort(environment.id, port, service)
      return {
        environmentId: environment.id,
        ...service ? { service } : {},
        port,
        forwarded: true,
        url: forwarded.url,
        note: 'The URL works on the human\'s machine, where Domo runs.'
      }
    }

    case 'schedule_task': {
      const target = await requireAgent(args.agentId ?? caller.id)
      await assertOwns(caller, target, 'scheduling a task for it')
      const normalized = normalizeCronJobInput({
        agentSessionId: target.id,
        name: args.name,
        prompt: args.prompt,
        cronExpression: args.cronExpression,
        runAt: args.runAt,
        timezone: args.timezone,
        delivery: args.delivery,
        createdBy: `agent:${caller.id}`
      })
      return describeJob(await createCronJob(normalized))
    }

    case 'list_scheduled_tasks': {
      if (args.jobId) {
        const job = await getCronJob(args.jobId)
        if (!job) throw new Error(`No scheduled task ${args.jobId}.`)
        const runs = await listCronRuns(job.id, 20)
        return {
          ...describeJob(job),
          runs: runs.map(run => ({
            scheduledFor: run.scheduledFor,
            status: run.status,
            ...run.outcome ? { outcome: run.outcome } : {},
            ...run.error ? { error: run.error } : {}
          }))
        }
      }
      const target = await requireAgent(args.agentId ?? caller.id)
      return { agentId: target.id, jobs: (await listCronJobs(target.id)).map(describeJob) }
    }

    case 'update_scheduled_task': {
      const existing = await getCronJob(args.jobId)
      if (!existing) throw new Error(`No scheduled task ${args.jobId}.`)
      await assertOwns(caller, await requireAgent(existing.agentSessionId), 'changing its scheduled task')
      const switchesToCron = args.cronExpression !== undefined
      const switchesToOnce = args.runAt !== undefined
      if (switchesToCron && switchesToOnce) throw new Error('Provide only one of cronExpression or runAt.')
      const normalized = normalizeCronJobInput({
        agentSessionId: existing.agentSessionId,
        name: args.name ?? existing.name,
        prompt: args.prompt ?? existing.prompt,
        cronExpression: switchesToOnce ? null : (args.cronExpression ?? existing.cronExpression),
        runAt: switchesToCron ? null : (args.runAt ?? existing.runAt),
        timezone: args.timezone ?? existing.timezone,
        delivery: args.delivery ?? existing.delivery,
        enabled: args.enabled ?? existing.enabled,
        createdBy: existing.createdBy
      })
      const replaced = await replaceCronJob(existing.id, normalized)
      return replaced ? describeJob(replaced) : null
    }

    case 'run_scheduled_task': {
      const job = await getCronJob(args.jobId)
      if (!job) throw new Error(`No scheduled task ${args.jobId}.`)
      await assertOwns(caller, await requireAgent(job.agentSessionId), 'running its scheduled task')
      const run = await startManualCronRun(job.id)
      try {
        // The same content, delivery and origin the scheduler uses, so a test
        // run is the real thing.
        const result = await acpManager.deliver(job.agentSessionId, {
          content: [{ type: 'text', text: `[Scheduled task "${job.name}" (${job.id})]\n\n${job.prompt}` }],
          delivery: job.delivery,
          origin: `cron:${job.id}`
        })
        await appendAgentEvent(job.agentSessionId, 'cron_triggered', {
          cronJobId: job.id, name: job.name, scheduledFor: run.scheduledFor, delivery: result.delivery, outcome: result.outcome, manual: true
        })
        await finishCronRun(run.id, 'delivered', result.outcome)
        return { jobId: job.id, agentId: job.agentSessionId, delivered: true, outcome: result.outcome }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await finishCronRun(run.id, 'failed', message).catch(() => {})
        throw error
      }
    }

    case 'delete_scheduled_task': {
      const existing = await getCronJob(args.jobId)
      if (!existing) throw new Error(`No scheduled task ${args.jobId}.`)
      await assertOwns(caller, await requireAgent(existing.agentSessionId), 'deleting its scheduled task')
      await deleteCronJob(existing.id)
      return { id: existing.id, deleted: true }
    }

    case 'notify_supervisor': {
      const { notification, spoken } = await notifyHuman({
        caller,
        message: args.message,
        urgent: args.urgent,
        files: Array.isArray(args.files) ? args.files : []
      })
      return {
        delivered: true,
        notificationId: notification.id,
        spoken,
        attachments: notification.attachments.map(attachment => attachment.name),
        note: 'Shown in Domo\'s notifications panel until the human marks it seen.'
      }
    }

    case 'get_usage_limits': {
      const wanted = args.provider === 'claude' || args.provider === 'codex' || args.provider === 'opencode'
        ? args.provider
        : undefined
      const [limits, providers] = await Promise.all([listUsageLimits(wanted), listUsageProviders()])
      return {
        providers: providers
          .filter(provider => !wanted || provider.provider === wanted)
          .map(provider => ({ provider: provider.provider, state: provider.state, ...provider.message ? { note: provider.message } : {} })),
        limits: limits.map(limit => ({
          provider: limit.provider,
          limit: limit.label,
          usedPercent: limit.usedPercent,
          resetsAt: limit.resetsAt,
          ...(limit.amountLimit === null && limit.amountUsed === null
            ? {}
            : { used: limit.amountUsed, of: limit.amountLimit, currency: limit.currency }),
          asOf: limit.updatedAt
        }))
      }
    }

    default:
      throw new Error(`Unknown mesh tool: ${tool}`)
  }
}
