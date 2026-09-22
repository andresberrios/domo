import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type FunctionDeclaration } from '@google/genai'

import { acpManager, normalizeCwd } from '../acp/manager'
import { listAdapterCatalog } from '../acp/models'
import { applyAgentSessionPatch } from '../acp/session-settings'
import { transcriptDigest, TRANSCRIPT_DIGEST_KINDS } from '../acp/transcript-digest'
import { exportBranch, listEnvironmentBranches, resolveIntoBranch } from '../dev-env/git-sync'
import { createEnvironment, startEnvironment, stopEnvironment } from '../dev-environments'
import { createProjectFromPath, removeProjectCascade, removeProjectEnvironment } from '../projects'
import { normalizeCronJobInput } from '../cron/input'
import {
  createCronJob,
  createVoiceSession,
  deleteCronJob,
  getAgentSession,
  getCronJob,
  getVoiceSession,
  listAgentSessions,
  listCronJobs,
  listDevEnvironments,
  listPermissions,
  listProjects,
  listUsageLimits,
  listUsageProviders,
  setAutoTitle,
  updateDevEnvironment,
  updateProject,
  updateVoiceSession
} from '../repo'
import { getSettings } from '../settings'
import type { AgentSession, MessageDelivery } from '../../../shared/types'

const DELIVERIES: MessageDelivery[] = ['steer', 'queue', 'interrupt']

export interface VoiceToolContext {
  voiceSessionId: string
  /** Move everyone listening to another conversation once this turn is spoken. */
  handOver: (voiceSessionId: string) => void
}

export interface VoiceTool {
  declaration: FunctionDeclaration
  handler: (args: any, ctx: VoiceToolContext) => Promise<any>
}

/** Pick the agent the user most likely means when they don't name one. */
async function resolveAgent(agentId?: string) {
  const sessions = await listAgentSessions()
  if (agentId) {
    const direct = sessions.find(s => s.id === agentId)
    if (direct) return direct
    const byTitle = sessions.find(
      s => s.title.toLowerCase() === agentId.toLowerCase()
        || s.title.toLowerCase().includes(agentId.toLowerCase())
    )
    if (byTitle) return byTitle
    throw new Error(`No coding agent matches "${agentId}". Call list_agent_sessions first.`)
  }
  if (!sessions.length) throw new Error('There are no coding agent sessions yet.')
  return sessions[0]!
}

/** Pick the project the user means from an id or a spoken name. */
async function resolveProject(identifier: string) {
  const projects = await listProjects()
  const direct = projects.find(p => p.id === identifier)
  if (direct) return direct
  const byName = projects.find(p => p.name.toLowerCase() === identifier.toLowerCase())
    ?? projects.find(p => p.name.toLowerCase().includes(identifier.toLowerCase()))
  if (byName) return byName
  throw new Error(`No project matches "${identifier}". Call list_dev_environments first.`)
}

/** Pick the development environment the user means from an id or a spoken name. */
async function resolveEnvironment(identifier: string) {
  const environments = await listDevEnvironments()
  const direct = environments.find(e => e.id === identifier)
  if (direct) return direct
  const byName = environments.find(e => e.name.toLowerCase() === identifier.toLowerCase())
    ?? environments.find(e => e.name.toLowerCase().includes(identifier.toLowerCase()))
  if (byName) return byName
  throw new Error(`No development environment matches "${identifier}". Call list_dev_environments first.`)
}

/** Spoken models dress titles up; the sidebar wants a plain few words. */
export function cleanTitle(raw: unknown): string {
  const title = String(raw ?? '')
    .split('\n')[0]!
    .replace(/^["'“”‘’*#\s]+|["'“”‘’*\s]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim()
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title
}

/** How full a session's context window is, as a whole percent, or null. */
function contextUsedPercent(usage: AgentSession['usage']): number | null {
  if (!usage || !usage.context.size) return null
  return Math.round((usage.context.used / usage.context.size) * 100)
}

function summarise(text: string | null, max = 400): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * The adapter's own settings, as a peer or the voice agent needs to read them:
 * what it is called, what it is on, and what else it could be. Both adapters
 * name reasoning effort differently and offer it only on some models, so this
 * is reported per session rather than documented per adapter.
 */
function describeConfig(session: AgentSession | null) {
  return (session?.configOptions ?? []).map(option => ({
    setting: option.name,
    id: option.id,
    value: session?.config?.[option.id] ?? option.currentValue,
    options: option.options.map(entry => entry.value)
  }))
}

export const voiceTools: Record<string, VoiceTool> = {
  start_new_conversation: {
    declaration: {
      name: 'start_new_conversation',
      description:
        'Start a brand-new conversation with fresh context and move the user into it. Use it only when the user asks to start over, clear the context, or begin a new conversation. Coding agents keep running and are still reachable from the new conversation. Say a short sign-off in the same turn; nothing from this conversation carries over.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async (_args, ctx) => {
      const session = await createVoiceSession()
      ctx.handOver(session.id)
      return { id: session.id, started: true }
    }
  },

  set_conversation_title: {
    declaration: {
      name: 'set_conversation_title',
      description:
        'Set the title this conversation is listed under. Call it on your own, without saying anything about it: once the topic is clear (usually after the first exchange), and again whenever the conversation moves on to clearly different work. 2 to 6 words, sentence case, naming the actual work ("Flaky invoice tests", "Auth refactor plan"), never "Conversation with user". Skip the call if the current title still fits.',
      parameters: {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING, description: 'The title, 2 to 6 words.' } },
        required: ['title']
      }
    },
    handler: async (args, ctx) => {
      const title = cleanTitle(args.title)
      if (!title) throw new Error('A title is required.')
      const session = await getVoiceSession(ctx.voiceSessionId)
      if (session?.titleSource === 'user') {
        return { applied: false, title: session.title, reason: 'The user named this conversation. Leave it unless they ask for a rename.' }
      }
      if (session?.title === title) return { applied: true, title }
      // Conditional on the source, so a rename landing in the meantime still wins.
      const updated = await setAutoTitle(ctx.voiceSessionId, title)
      return updated
        ? { applied: true, title }
        : { applied: false, reason: 'The user named this conversation meanwhile. Leave it.' }
    }
  },

  rename_conversation: {
    declaration: {
      name: 'rename_conversation',
      description:
        'Rename the current conversation because the user asked to call it something. Their title sticks: set_conversation_title will not replace it.',
      parameters: {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING, description: 'New title, a few words.' } },
        required: ['title']
      }
    },
    handler: async (args, ctx) => {
      const title = cleanTitle(args.title)
      if (!title) throw new Error('A title is required.')
      await updateVoiceSession(ctx.voiceSessionId, { title, titleSource: 'user' })
      return { title }
    }
  },

  list_agent_sessions: {
    declaration: {
      name: 'list_agent_sessions',
      description:
        'List every coding agent session with its id, title, working directory, status, and a short summary of its latest output. Call this before answering any question about what the agents are doing.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      const sessions = await listAgentSessions()
      const pending = await listPermissions(undefined, true)
      return {
        agents: sessions.map(session => ({
          id: session.id,
          title: session.title,
          adapter: session.adapter,
          cwd: session.cwd,
          devEnvironmentId: session.devEnvironmentId,
          status: session.status,
          mode: session.modeId,
          lastActivityAt: session.lastActivityAt,
          summary: summarise(session.summary, 300),
          awaitingPermission: pending.filter(p => p.agentSessionId === session.id).length,
          // Only when it is known: an absent field is "no reading yet", which
          // the model can say, while a zero would be a claim that the context
          // is empty.
          ...contextUsedPercent(session.usage) === null
            ? {}
            : { contextUsedPercent: contextUsedPercent(session.usage) }
        }))
      }
    }
  },

  schedule_agent_task: {
    declaration: {
      name: 'schedule_agent_task',
      description: 'Schedule a recurring prompt or one-time wakeup for a coding agent.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title. Omit for the most recently active agent.' },
          name: { type: Type.STRING, description: 'Short label for the task.' },
          prompt: { type: Type.STRING, description: 'Instruction the agent receives when the task fires.' },
          cronExpression: { type: Type.STRING, description: 'Five-field cron expression for a recurring task.' },
          runAt: { type: Type.STRING, description: 'ISO 8601 time for a one-time task.' },
          timezone: { type: Type.STRING, description: 'IANA time zone for cronExpression. Defaults to UTC.' },
          delivery: { type: Type.STRING, enum: ['queue', 'steer', 'interrupt'], description: 'Behavior if the agent is busy. Defaults to queue.' }
        },
        required: ['name', 'prompt']
      }
    },
    handler: async (args) => {
      const agent = await resolveAgent(args.agentId)
      const input = normalizeCronJobInput({
        agentSessionId: agent.id,
        name: args.name,
        prompt: args.prompt,
        cronExpression: args.cronExpression,
        runAt: args.runAt,
        timezone: args.timezone,
        delivery: args.delivery,
        createdBy: 'voice'
      })
      return createCronJob(input)
    }
  },

  list_scheduled_tasks: {
    declaration: {
      name: 'list_scheduled_tasks',
      description: 'List the tasks scheduled to wake a coding agent.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title. Omit for the most recently active agent.' }
        }
      }
    },
    handler: async (args) => {
      const agent = await resolveAgent(args.agentId)
      return { agentId: agent.id, title: agent.title, jobs: await listCronJobs(agent.id) }
    }
  },

  delete_scheduled_task: {
    declaration: {
      name: 'delete_scheduled_task',
      description: 'Delete one scheduled task from a coding agent.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title. Omit for the most recently active agent.' },
          jobId: { type: Type.STRING, description: 'Scheduled task id from list_scheduled_tasks.' }
        },
        required: ['jobId']
      }
    },
    handler: async (args) => {
      const agent = await resolveAgent(args.agentId)
      const job = await getCronJob(args.jobId)
      if (!job || job.agentSessionId !== agent.id) {
        throw new Error(`No scheduled task ${args.jobId} belongs to agent "${agent.title}".`)
      }
      await deleteCronJob(job.id)
      return { id: job.id, deleted: true }
    }
  },

  list_models: {
    declaration: {
      name: 'list_models',
      description:
        'List the coding-agent harnesses Domo can run and the models each offers; call this before spawning with a specific model so you pick a real id.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          adapter: {
            type: Type.STRING,
            enum: ['claude-code', 'codex'],
            description: 'Only this harness. Omit for all of them.'
          }
        }
      }
    },
    // The same cached probe the picker uses; there is no second spawn path.
    handler: async args => listAdapterCatalog(
      args.adapter === 'codex' || args.adapter === 'claude-code' ? args.adapter : undefined
    )
  },

  create_agent_session: {
    declaration: {
      name: 'create_agent_session',
      description:
        'Start a new Claude Code or Codex agent session and optionally give it its first task. Use this when the user wants new work done in parallel.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: 'Short human name for the session, e.g. "auth refactor".' },
          adapter: {
            type: Type.STRING,
            enum: ['claude-code', 'codex'],
            description: 'Coding agent to run. Defaults to Claude Code.'
          },
          task: { type: Type.STRING, description: 'The first instruction for the agent.' },
          cwd: {
            type: Type.STRING,
            description: 'Absolute path of the repository to work in. Omit to use the configured default workspace.'
          },
          devEnvironmentId: {
            type: Type.STRING,
            description: 'Development environment id from list_dev_environments. Prefer this over cwd.'
          },
          model: {
            type: Type.STRING,
            description: 'Optional model id; ids come from list_models. Omit for the default.'
          }
        },
        required: ['title']
      }
    },
    handler: async (args, ctx) => {
      const session = await acpManager.create({
        adapter: args.adapter === 'codex' ? 'codex' : 'claude-code',
        title: args.title,
        cwd: args.cwd,
        devEnvironmentId: args.devEnvironmentId,
        voiceSessionId: ctx.voiceSessionId,
        model: args.model,
        initialPrompt: args.task
      })
      return {
        id: session.id,
        title: session.title,
        adapter: session.adapter,
        cwd: session.cwd,
        model: session.model,
        status: session.status,
        started: !!args.task
      }
    }
  },

  list_dev_environments: {
    declaration: {
      name: 'list_dev_environments',
      description: 'List projects and their isolated development environments. Each environment can host multiple coding agents and its own Docker Compose stacks.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      const [projects, environments, agents] = await Promise.all([
        listProjects(),
        listDevEnvironments(),
        listAgentSessions()
      ])
      return {
        projects: projects.map(project => ({
          id: project.id,
          name: project.name,
          sourceRepository: project.repoPath,
          environments: environments
            .filter(environment => environment.projectId === project.id)
            .map(environment => ({
              id: environment.id,
              name: environment.name,
              status: environment.status,
              workspace: environment.workspacePath,
              agentCount: agents.filter(agent => agent.devEnvironmentId === environment.id).length
            }))
        }))
      }
    }
  },

  create_project: {
    declaration: {
      name: 'create_project',
      description:
        'Add a new project backed by a local Git checkout, so development environments can be created from it. Use list_directories first to find the path if the user has not given an absolute one.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          repoPath: { type: Type.STRING, description: 'Absolute path to a local Git checkout.' },
          name: { type: Type.STRING, description: 'Display name for the project. Defaults to the directory name.' }
        },
        required: ['repoPath']
      }
    },
    handler: async (args) => {
      const project = await createProjectFromPath({ name: args.name, repoPath: args.repoPath })
      return { id: project.id, name: project.name, repoPath: project.repoPath }
    }
  },

  update_project: {
    declaration: {
      name: 'update_project',
      description: 'Rename a project.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          project: { type: Type.STRING, description: 'Project id or name, from list_dev_environments.' },
          name: { type: Type.STRING, description: 'New name.' }
        },
        required: ['project', 'name']
      }
    },
    handler: async (args) => {
      const project = await resolveProject(args.project)
      const name = String(args.name ?? '').trim()
      if (!name) throw new Error('A name is required.')
      const updated = await updateProject(project.id, { name })
      return { id: project.id, name: updated?.name ?? name }
    }
  },

  delete_project: {
    declaration: {
      name: 'delete_project',
      description:
        'Delete a project along with every one of its development environments: their containers, checkouts, and coding agent sessions. This cannot be undone. Always confirm with the user before calling it.',
      parameters: {
        type: Type.OBJECT,
        properties: { project: { type: Type.STRING, description: 'Project id or name, from list_dev_environments.' } },
        required: ['project']
      }
    },
    handler: async (args) => {
      const project = await resolveProject(args.project)
      await removeProjectCascade(project.id)
      return { id: project.id, deleted: true }
    }
  },

  create_dev_environment: {
    declaration: {
      name: 'create_dev_environment',
      description:
        'Create a new isolated development environment for a project: a container with its own copy of the repository. This can take a while; tell the user it is starting rather than waiting silently.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          project: { type: Type.STRING, description: 'Project id or name, from list_dev_environments.' },
          name: { type: Type.STRING, description: 'Short name for the environment, e.g. "feature-auth".' }
        },
        required: ['project', 'name']
      }
    },
    handler: async (args) => {
      const project = await resolveProject(args.project)
      const name = String(args.name ?? '').trim()
      if (!name) throw new Error('A name is required.')
      const environment = await createEnvironment({ projectId: project.id, name })
      return { id: environment.id, name: environment.name, status: environment.status, workspace: environment.workspacePath }
    }
  },

  update_dev_environment: {
    declaration: {
      name: 'update_dev_environment',
      description: 'Rename a development environment, or start/stop its container.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          environment: { type: Type.STRING, description: 'Environment id or name, from list_dev_environments.' },
          name: { type: Type.STRING, description: 'New name.' },
          status: { type: Type.STRING, enum: ['running', 'stopped'], description: 'Start or stop the container.' }
        },
        required: ['environment']
      }
    },
    handler: async (args) => {
      const environment = await resolveEnvironment(args.environment)
      let current = environment
      if (args.status === 'running') current = await startEnvironment(environment.id)
      else if (args.status === 'stopped') current = await stopEnvironment(environment.id)
      const name = String(args.name ?? '').trim()
      if (name) current = (await updateDevEnvironment(environment.id, { name })) ?? current
      return { id: current.id, name: current.name, status: current.status }
    }
  },

  delete_dev_environment: {
    declaration: {
      name: 'delete_dev_environment',
      description:
        'Delete a development environment: its container, checkout, and any coding agent sessions running in it. This cannot be undone. Always confirm with the user before calling it.',
      parameters: {
        type: Type.OBJECT,
        properties: { environment: { type: Type.STRING, description: 'Environment id or name, from list_dev_environments.' } },
        required: ['environment']
      }
    },
    handler: async (args) => {
      const environment = await resolveEnvironment(args.environment)
      await removeProjectEnvironment(environment.id)
      return { id: environment.id, deleted: true }
    }
  },

  export_branch: {
    declaration: {
      name: 'export_branch',
      description:
        'Copy a branch out of a development environment into the project’s checkout on this machine. Fast-forward only; nothing on this machine is rewritten.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          environment: { type: Type.STRING, description: 'Environment id or name, from list_dev_environments.' },
          branch: { type: Type.STRING, description: 'Branch in the environment. Omit for the one checked out there.' },
          into: { type: Type.STRING, description: 'Local branch to fast-forward. Omit for the same name; pass an empty string to fetch only.' }
        },
        required: ['environment']
      }
    },
    handler: async (args) => {
      const environment = await resolveEnvironment(args.environment)
      const branch = String(args.branch ?? '').trim()
        || (await listEnvironmentBranches(environment.id)).current
      if (!branch) throw new Error(`${environment.name} has no branch checked out; name the branch to export.`)
      const exported = await exportBranch({
        environmentId: environment.id,
        branch,
        into: resolveIntoBranch(branch, args.into)
      })
      return { environment: environment.name, branch, ...exported }
    }
  },

  send_agent_message: {
    declaration: {
      name: 'send_agent_message',
      description:
        'Send a message to a coding agent session. This returns as soon as the message has been handed over, so follow up with get_agent_transcript to see what happened.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title. Omit for the most recently active one.' },
          message: { type: Type.STRING, description: 'What to tell the agent.' },
          delivery: {
            type: Type.STRING,
            enum: ['steer', 'queue', 'interrupt'],
            description:
              'What to do when the agent is already working. "steer" (default) puts the message into the turn '
              + 'it is running now, "queue" waits for that turn to finish, "interrupt" stops it first. '
              + 'An idle agent starts on the message immediately either way.'
          }
        },
        required: ['message']
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      // The user is talking to Domo *now*, so the default puts the message into
      // the turn that is running rather than behind it.
      const delivery = DELIVERIES.find(mode => mode === args.delivery) ?? 'steer'
      const result = await acpManager.deliver(session.id, {
        content: [{ type: 'text', text: args.message }],
        delivery,
        origin: 'voice'
      })
      return {
        id: session.id,
        title: session.title,
        delivered: true,
        delivery: result.delivery,
        outcome: result.outcome
      }
    }
  },

  get_agent_transcript: {
    declaration: {
      name: 'get_agent_transcript',
      description:
        'Read a condensed transcript of a coding agent session: its recent messages, tool calls, plan and errors. Use it to answer "what is it doing" questions.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title. Omit for the most recently active one.' },
          limit: { type: Type.INTEGER, description: 'How many recent items to return (default 20, maximum 100).' },
          include: {
            type: Type.ARRAY,
            items: { type: Type.STRING, enum: [...TRANSCRIPT_DIGEST_KINDS] },
            description: 'Kinds to include. Defaults to messages, thoughts, tools, plan and notices.'
          }
        }
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      const items = await transcriptDigest(session.id, { limit: args.limit, include: args.include })
      return { id: session.id, title: session.title, status: session.status, items }
    }
  },

  cancel_agent_turn: {
    declaration: {
      name: 'cancel_agent_turn',
      description: 'Stop what a coding agent is currently doing. Its conversation is kept, only the running turn is aborted.',
      parameters: {
        type: Type.OBJECT,
        properties: { agentId: { type: Type.STRING, description: 'Agent session id or title.' } }
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      await acpManager.cancel(session.id)
      return { id: session.id, title: session.title, cancelled: true }
    }
  },

  list_pending_permissions: {
    declaration: {
      name: 'list_pending_permissions',
      description:
        'List coding-agent permission requests that are waiting for a decision, with the options that can be chosen.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      const pending = await listPermissions(undefined, true)
      const sessions = await listAgentSessions(true)
      return {
        permissions: pending.map(permission => ({
          permissionId: permission.id,
          agentId: permission.agentSessionId,
          agentTitle: sessions.find(s => s.id === permission.agentSessionId)?.title ?? 'unknown',
          request: permission.title,
          options: permission.options
        }))
      }
    }
  },

  answer_permission: {
    declaration: {
      name: 'answer_permission',
      description:
        'Answer a waiting permission request on behalf of the user. Always confirm with the user first, then pass the exact optionId from list_pending_permissions.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          permissionId: { type: Type.STRING, description: 'Id of the permission request.' },
          optionId: { type: Type.STRING, description: 'Exact optionId to select.' }
        },
        required: ['permissionId', 'optionId']
      }
    },
    handler: async (args) => {
      const pending = await listPermissions(undefined, true)
      const permission = pending.find(p => p.id === args.permissionId)
      if (!permission) throw new Error('That permission request is no longer waiting.')
      if (!permission.options.some(option => option.optionId === args.optionId)) {
        throw new Error(`Option "${args.optionId}" is not offered. Options: ${permission.options.map(o => o.optionId).join(', ')}`)
      }
      await acpManager.answerPermission(permission.agentSessionId, permission.id, args.optionId, 'voice-agent')
      return { answered: true, optionId: args.optionId }
    }
  },

  manage_agent_session: {
    declaration: {
      name: 'manage_agent_session',
      description:
        'Update a coding agent session: rename it, change its permission mode, switch its model, and/or '
        + 'archive it, and change any setting the adapter itself offers (reasoning effort, for one). '
        + 'Pass only the fields you want to change — everything but agentId is optional. '
        + 'Call list_models first if you are not sure what model id the agent\'s adapter offers.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title.' },
          title: { type: Type.STRING, description: 'New title.' },
          modeId: {
            type: Type.STRING,
            description: 'Permission mode id to switch to, e.g. "default" (ask every time), "acceptEdits", "plan", or "bypassPermissions".'
          },
          model: { type: Type.STRING, description: 'Model id or name to switch the session to.' },
          setting: {
            type: Type.STRING,
            description:
              'One of the adapter\'s own settings to change, by name — "reasoning effort" works on either adapter. '
              + 'Call get_agent_status to see which settings this session has and what values they take.'
          },
          settingValue: { type: Type.STRING, description: 'The value for `setting`, e.g. "high".' },
          archived: { type: Type.BOOLEAN, description: 'Set true to shut the session down and hide it from the session list.' }
        }
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      return applyAgentSessionPatch(session, {
        ...args,
        // One named setting at a time: a spoken instruction is "set the
        // reasoning effort to high", never a map, and the ids differ per
        // adapter anyway (`effort` vs `reasoning_effort`) so the name is what
        // a caller can actually be expected to know.
        config: args.setting && args.settingValue ? { [args.setting]: args.settingValue } : undefined
      })
    }
  },

  list_directories: {
    declaration: {
      name: 'list_directories',
      description:
        'List sub-directories of a path on this machine so you can pick a working directory for a new agent. Omit the path to list the default workspace.',
      parameters: {
        type: Type.OBJECT,
        properties: { path: { type: Type.STRING, description: 'Absolute directory path.' } }
      }
    },
    handler: async (args) => {
      const settings = await getSettings()
      const base = normalizeCwd(args.path || settings.defaultCwd)
      const entries = await readdir(base, { withFileTypes: true })
      const dirs: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        dirs.push(entry.name)
        if (dirs.length >= 60) break
      }
      return { path: base, directories: dirs }
    }
  },

  get_usage_limits: {
    declaration: {
      name: 'get_usage_limits',
      description:
        'Report how much of the Claude and Codex plan limits are used up, when each window resets, '
        + 'and any usage credits. Call this before answering anything about quota, limits, '
        + '"how much is left", or why an agent was cut off. Percentages are 0-100 of the window used.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          provider: {
            type: Type.STRING,
            enum: ['claude', 'codex'],
            description: 'Only this account. Omit for both.'
          }
        }
      }
    },
    handler: async (args) => {
      const wanted = args.provider === 'claude' || args.provider === 'codex' ? args.provider : undefined
      const [limits, providers] = await Promise.all([listUsageLimits(wanted), listUsageProviders()])
      return {
        providers: providers
          .filter(provider => !wanted || provider.provider === wanted)
          .map(provider => ({
            provider: provider.provider,
            // `unconfigured` and `error` are both "there is nothing to report
            // and here is why" — say the reason rather than inventing a number.
            state: provider.state,
            note: provider.message,
            checkedAt: provider.checkedAt
          })),
        limits: limits.map(limit => ({
          provider: limit.provider,
          limit: limit.label,
          usedPercent: limit.usedPercent,
          resetsAt: limit.resetsAt,
          status: limit.status,
          ...(limit.amountLimit === null && limit.amountUsed === null
            ? {}
            : { used: limit.amountUsed, of: limit.amountLimit, currency: limit.currency }),
          // A reading is only as good as its age, and the polls are far apart.
          asOf: limit.updatedAt
        }))
      }
    }
  },

  get_agent_status: {
    declaration: {
      name: 'get_agent_status',
      description: 'Get the current status of one coding agent session, including whether it is waiting on a decision.',
      parameters: {
        type: Type.OBJECT,
        properties: { agentId: { type: Type.STRING, description: 'Agent session id or title.' } }
      }
    },
    handler: async (args) => {
      const resolved = await resolveAgent(args.agentId)
      const session = await getAgentSession(resolved.id)
      const pending = await listPermissions(resolved.id, true)
      return {
        id: session?.id,
        title: session?.title,
        status: session?.status,
        mode: session?.modeId,
        model: session?.model,
        settings: describeConfig(session ?? null),
        cwd: session?.cwd,
        lastError: session?.lastError,
        summary: summarise(session?.summary ?? null, 500),
        pendingPermissions: pending.map(p => ({ permissionId: p.id, request: p.title, options: p.options }))
      }
    }
  }
}

export function voiceToolDeclarations(options: { autoTitle: boolean }): FunctionDeclaration[] {
  return Object.values(voiceTools)
    .map(tool => tool.declaration)
    .filter(declaration => options.autoTitle || declaration.name !== 'set_conversation_title')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function listChildDirectories(path: string): Promise<Array<{ name: string, path: string }>> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
