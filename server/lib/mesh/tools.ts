import { acpManager, normalizeCwd } from '../acp/manager'
import { listAdapterCatalog } from '../acp/models'
import { startSubscriptionNotifier, watch } from '../acp/subscriptions'
import { createEnvironment, startEnvironment, stopEnvironment } from '../dev-environments'
import { createProjectFromPath, removeProjectCascade, removeProjectEnvironment } from '../projects'
import {
  addAgentSubscription,
  appendAgentEvent,
  getAgentSession,
  getDevEnvironment,
  listAgentSessions,
  listAgentSubscriptions,
  listDevEnvironments,
  listProjects,
  removeAgentSubscription,
  updateDevEnvironment,
  updateProject
} from '../repo'
import { voiceManager } from '../voice/runtime'
import type { MessageDelivery } from '../../../shared/types'

const DELIVERIES: MessageDelivery[] = ['steer', 'queue', 'interrupt']

/**
 * Record that `subscriber` wants to hear about `target`.
 *
 * Refuses the two shapes that are only ever a mistake: following yourself, and
 * closing a two-agent loop, where each finished turn is a message to the other
 * and every message is a turn. Nothing here walks the whole graph — a longer
 * cycle is possible and is the caller's business — but the pair that costs
 * nothing to make is worth catching.
 */
async function subscribe(subscriberId: string, targetId: string): Promise<void> {
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
  await addAgentSubscription(subscriberId, targetId)
  watch(targetId)
}

/**
 * The agent mesh: what a coding agent can do to the rest of Domo.
 *
 * Every session Domo spawns gets these five tools through the built-in `domo`
 * MCP server (`server/api/internal/mcp.ts`). They are how agents see each
 * other, hand work over, spawn peers, pick a model and page the voice
 * supervisor.
 */
export const MESH_TOOLS = [
  {
    name: 'list_models',
    description:
      'List the coding-agent harnesses Domo can run and the models each offers; call this before spawning with a specific model so you pick a real id.',
    inputSchema: {
      type: 'object',
      properties: {
        adapter: {
          type: 'string',
          enum: ['claude-code', 'codex'],
          description: 'Only this harness. Omit for all of them.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_agents',
    description:
      'List the other coding agent sessions running in Domo, with their id, title, working directory, status and a short summary of their latest output.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'message_agent',
    description:
      'Send a message to another coding agent session. By default it waits for that agent to finish what it is doing and is delivered as its next turn; nothing is lost if it is busy.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Target agent session id (from list_agents).' },
        message: { type: 'string', description: 'What to tell that agent.' },
        delivery: {
          type: 'string',
          enum: ['steer', 'queue', 'interrupt'],
          description:
            'When the agent is busy: "queue" (default) waits for its current turn to end, '
            + '"steer" injects the message into the turn it is running now, and "interrupt" '
            + 'cancels that turn first. An idle agent starts on it immediately either way.'
        }
      },
      required: ['agentId', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'spawn_agent',
    description:
      'Spawn a brand new coding agent session on a task. Use this to parallelise independent work. Returns the new agent id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the new agent session.' },
        prompt: { type: 'string', description: 'The task to hand to the new agent.' },
        cwd: {
          type: 'string',
          description: 'Absolute working directory for host sessions. Agents in a dev environment always spawn their peer in the same environment.'
        },
        model: {
          type: 'string',
          description: 'Optional model id; ids come from list_models. Omit for the default.'
        },
        notifyWhenDone: {
          type: 'boolean',
          description:
            'Be told when the new agent finishes a turn, needs a permission, or fails. Defaults to true — '
            + 'you cannot wait for a peer, so this is how you find out. Set false for work you will not follow up on.'
        }
      },
      required: ['title', 'prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'subscribe_to_agent',
    description:
      'Be told when another coding agent finishes a turn, stops for a permission, or fails. The note arrives as a message in your own session, with a summary of that agent\'s latest output.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent session id to follow (from list_agents).' }
      },
      required: ['agentId'],
      additionalProperties: false
    }
  },
  {
    name: 'unsubscribe_from_agent',
    description: 'Stop being told what another coding agent is doing.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent session id to stop following.' }
      },
      required: ['agentId'],
      additionalProperties: false
    }
  },
  {
    name: 'list_projects',
    description:
      'List projects and their isolated development environments, with ids for use with the project and environment tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_project',
    description:
      'Add a new project backed by a local Git checkout, so development environments can be created from it.',
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'Absolute path to a local Git checkout.' },
        name: { type: 'string', description: 'Display name for the project. Defaults to the directory name.' }
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
    name: 'delete_project',
    description:
      'Delete a project along with every one of its development environments: their containers, checkouts, and coding agent sessions. Cannot be undone.',
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
      'Create a new isolated development environment for a project: a container with its own copy of the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id, from list_projects.' },
        name: { type: 'string', description: 'Short name for the environment, e.g. "feature-auth".' }
      },
      required: ['projectId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'update_dev_environment',
    description: 'Rename a development environment, or start/stop its container.',
    inputSchema: {
      type: 'object',
      properties: {
        environmentId: { type: 'string', description: 'Environment id, from list_projects.' },
        name: { type: 'string', description: 'New name.' },
        status: { type: 'string', enum: ['running', 'stopped'], description: 'Start or stop the container.' }
      },
      required: ['environmentId'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_dev_environment',
    description:
      'Delete a development environment: its container, checkout, and any coding agent sessions running in it. Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { environmentId: { type: 'string', description: 'Environment id, from list_projects.' } },
      required: ['environmentId'],
      additionalProperties: false
    }
  },
  {
    name: 'notify_supervisor',
    description:
      'Say something to the human’s voice supervisor agent. Use it to report a milestone, flag a blocker, or ask a question that needs a human decision. The supervisor may speak it out loud.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to tell the supervisor.' },
        urgent: { type: 'boolean', description: 'Set when the human should be interrupted now.' }
      },
      required: ['message'],
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
  const args = (input ?? {}) as any

  switch (tool) {
    case 'list_models':
      // The same cached probe the picker uses; there is no second spawn path.
      return listAdapterCatalog(args.adapter === 'codex' || args.adapter === 'claude-code' ? args.adapter : undefined)

    case 'list_agents': {
      const sessions = await listAgentSessions()
      return {
        agents: sessions
          .filter(session => session.id !== caller.id)
          .map(session => ({
            id: session.id,
            title: session.title,
            adapter: session.adapter,
            cwd: session.cwd,
            status: session.status,
            summary: (session.summary ?? '').replace(/\s+/g, ' ').slice(0, 400)
          }))
      }
    }

    case 'message_agent': {
      const target = await getAgentSession(args.agentId)
      if (!target) throw new Error(`No agent ${args.agentId}`)
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

    case 'spawn_agent': {
      const session = await acpManager.create({
        adapter: caller.adapter,
        title: args.title,
        cwd: caller.devEnvironmentId ? undefined : (args.cwd ? normalizeCwd(args.cwd) : caller.cwd),
        devEnvironmentId: caller.devEnvironmentId ?? null,
        voiceSessionId: caller.voiceSessionId ?? null,
        model: args.model ?? null,
        initialPrompt: args.prompt
      })
      // The caller is an agent by definition here, and an agent cannot wait for
      // its peer — so following it is the default, not the opt-in.
      const notify = args.notifyWhenDone !== false
      if (notify) await subscribe(caller.id, session.id)
      await appendAgentEvent(caller.id, 'mesh_spawned', {
        agentId: session.id, title: session.title, notifyWhenDone: notify
      })
      return {
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        model: session.model,
        notifyWhenDone: notify
      }
    }

    case 'subscribe_to_agent': {
      const target = await getAgentSession(args.agentId)
      if (!target) throw new Error(`No agent ${args.agentId}`)
      await subscribe(caller.id, target.id)
      return { subscribed: true, agentId: target.id, title: target.title }
    }

    case 'unsubscribe_from_agent': {
      const removed = await removeAgentSubscription(caller.id, args.agentId)
      return { subscribed: false, agentId: args.agentId, wasSubscribed: removed }
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
              workspace: environment.workspacePath
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

    case 'delete_project': {
      const environments = await listDevEnvironments(args.projectId)
      if (caller.devEnvironmentId && environments.some(environment => environment.id === caller.devEnvironmentId)) {
        throw new Error('Refusing to delete the project this agent session is running in. Ask the user or another agent to do it.')
      }
      await removeProjectCascade(args.projectId)
      return { id: args.projectId, deleted: true }
    }

    case 'create_dev_environment': {
      const environment = await createEnvironment({ projectId: args.projectId, name: args.name })
      return { id: environment.id, name: environment.name, status: environment.status, workspace: environment.workspacePath }
    }

    case 'update_dev_environment': {
      let current = await getDevEnvironment(args.environmentId)
      if (!current) throw new Error(`No environment ${args.environmentId}`)
      if (args.status === 'running') current = await startEnvironment(current.id)
      else if (args.status === 'stopped') current = await stopEnvironment(current.id)
      const name = String(args.name ?? '').trim()
      if (name) current = (await updateDevEnvironment(current.id, { name })) ?? current
      return { id: current.id, name: current.name, status: current.status }
    }

    case 'delete_dev_environment': {
      if (caller.devEnvironmentId === args.environmentId) {
        throw new Error('Refusing to delete the environment this agent session is running in. Ask the user or another agent to do it.')
      }
      await removeProjectEnvironment(args.environmentId)
      return { id: args.environmentId, deleted: true }
    }

    case 'notify_supervisor': {
      await appendAgentEvent(caller.id, 'mesh_message', {
        from: caller.title,
        agentId: caller.id,
        message: args.message,
        urgent: !!args.urgent
      })
      const runtime = voiceManager.active()
      if (runtime) {
        await runtime.injectNote(`Agent "${caller.title}" (${caller.id}) reports: ${args.message}`, true)
        return { delivered: true, spoken: true }
      }
      return { delivered: true, spoken: false, note: 'No live voice session; the message is in the activity log.' }
    }

    default:
      throw new Error(`Unknown mesh tool: ${tool}`)
  }
}
