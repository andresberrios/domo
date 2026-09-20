import { acpManager, normalizeCwd } from '../acp/manager'
import { appendAgentEvent, getAgentSession, listAgentSessions } from '../repo'
import { voiceManager } from '../voice/runtime'

/**
 * The agent mesh: what a coding agent can do to the rest of Domo.
 *
 * Every session Domo spawns gets these four tools through the built-in `domo`
 * MCP server (`server/api/internal/mcp.ts`). They are how agents see each
 * other, hand work over, spawn peers and page the voice supervisor.
 */
export const MESH_TOOLS = [
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
        }
      },
      required: ['title', 'prompt'],
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
        initialPrompt: args.prompt
      })
      await appendAgentEvent(caller.id, 'mesh_spawned', { agentId: session.id, title: session.title })
      return { id: session.id, title: session.title, cwd: session.cwd }
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
