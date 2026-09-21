import { acpManager, normalizeCwd } from '../acp/manager'
import { listAdapterCatalog } from '../acp/models'
import { exportBranch, listEnvironmentBranches, resolveIntoBranch } from '../dev-env/git-sync'
import { createEnvironment, startEnvironment, stopEnvironment } from '../dev-environments'
import { createProjectFromPath, removeProjectCascade, removeProjectEnvironment } from '../projects'
import {
  appendAgentEvent,
  getAgentSession,
  getDevEnvironment,
  listAgentSessions,
  listDevEnvironments,
  listProjects,
  updateDevEnvironment,
  updateProject
} from '../repo'
import { voiceManager } from '../voice/runtime'

/**
 * The agent mesh: what a coding agent can do to the rest of Domo.
 *
 * Every session Domo spawns gets these tools through the built-in `domo`
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
      'Send a message to another coding agent session. The message is delivered as a new user turn in that session and it will start working on it immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Target agent session id (from list_agents).' },
        message: { type: 'string', description: 'What to tell that agent.' }
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
        }
      },
      required: ['title', 'prompt'],
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
    name: 'export_branch',
    description:
      'Copy a branch out of a development environment into the project\'s own checkout on the host, by fetching it straight from the container. Fast-forward only: it never rewrites or merges anything on the host.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch in the environment. Defaults to the one checked out there.' },
        into: {
          type: 'string',
          description: 'Local branch on the host to fast-forward. Defaults to the same name; pass an empty string to fetch without touching a branch.'
        },
        devEnvironmentId: {
          type: 'string',
          description: 'Environment to export from, from list_projects. Defaults to this agent\'s own environment.'
        }
      },
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
      void acpManager.promptInBackground(target.id, [
        { type: 'text', text: `[Message from agent "${from}" (${caller.id})]\n\n${args.message}` }
      ])
      await appendAgentEvent(target.id, 'mesh_inbound', { from: caller.id, fromTitle: from, message: args.message })
      await appendAgentEvent(caller.id, 'mesh_outbound', { to: target.id, toTitle: target.title, message: args.message })
      return { delivered: true, agentId: target.id, title: target.title }
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
      await appendAgentEvent(caller.id, 'mesh_spawned', { agentId: session.id, title: session.title })
      return { id: session.id, title: session.title, cwd: session.cwd, model: session.model }
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

    case 'export_branch': {
      const environmentId = String(args.devEnvironmentId ?? caller.devEnvironmentId ?? '')
      if (!environmentId) {
        throw new Error('This agent is not running in a development environment; pass devEnvironmentId (from list_projects).')
      }
      const branch = String(args.branch ?? '').trim() || (await listEnvironmentBranches(environmentId)).current
      if (!branch) {
        throw new Error('That environment has no branch checked out; name the branch to export.')
      }
      return exportBranch({ environmentId, branch, into: resolveIntoBranch(branch, args.into) })
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
