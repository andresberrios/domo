import { acpManager, normalizeCwd } from '../../lib/acp/manager'
import { appendAgentEvent, getAgentSession, listAgentSessions } from '../../lib/repo'
import { voiceManager } from '../../lib/voice/runtime'

/**
 * Callback surface for the agent-mesh MCP server that every coding agent gets.
 * Loopback only — it is how agents see each other, hand off work, spawn peers
 * and talk to the voice supervisor.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ tool: string, args: any, agentSessionId: string }>(event)
  const caller = body?.agentSessionId ? await getAgentSession(body.agentSessionId) : null
  const args = body?.args ?? {}

  switch (body?.tool) {
    case 'list_agents': {
      const sessions = await listAgentSessions()
      return {
        agents: sessions
          .filter(session => session.id !== caller?.id)
          .map(session => ({
            id: session.id,
            title: session.title,
            cwd: session.cwd,
            status: session.status,
            summary: (session.summary ?? '').replace(/\s+/g, ' ').slice(0, 400)
          }))
      }
    }

    case 'message_agent': {
      const target = await getAgentSession(args.agentId)
      if (!target) throw createError({ statusCode: 404, statusMessage: `No agent ${args.agentId}` })
      const from = caller?.title ?? 'another agent'
      void acpManager.promptInBackground(target.id, [
        { type: 'text', text: `[Message from agent "${from}" (${caller?.id ?? 'unknown'})]\n\n${args.message}` }
      ])
      await appendAgentEvent(target.id, 'mesh_inbound', { from: caller?.id, fromTitle: from, message: args.message })
      if (caller) {
        await appendAgentEvent(caller.id, 'mesh_outbound', { to: target.id, toTitle: target.title, message: args.message })
      }
      return { delivered: true, agentId: target.id, title: target.title }
    }

    case 'spawn_agent': {
      const session = await acpManager.create({
        title: args.title,
        cwd: caller?.devEnvironmentId ? undefined : (args.cwd ? normalizeCwd(args.cwd) : caller?.cwd),
        devEnvironmentId: caller?.devEnvironmentId ?? null,
        voiceSessionId: caller?.voiceSessionId ?? null,
        initialPrompt: args.prompt
      })
      if (caller) {
        await appendAgentEvent(caller.id, 'mesh_spawned', { agentId: session.id, title: session.title })
      }
      return { id: session.id, title: session.title, cwd: session.cwd }
    }

    case 'notify_supervisor': {
      if (caller) {
        await appendAgentEvent(caller.id, 'mesh_message', {
          from: caller.title,
          agentId: caller.id,
          message: args.message,
          urgent: !!args.urgent
        })
      }
      const runtime = voiceManager.active()
      if (runtime) {
        await runtime.injectNote(
          `Agent "${caller?.title ?? 'unknown'}" (${caller?.id ?? '?'}) reports: ${args.message}`,
          true
        )
        return { delivered: true, spoken: true }
      }
      return { delivered: true, spoken: false, note: 'No live voice session; the message is in the activity log.' }
    }

    default:
      throw createError({ statusCode: 400, statusMessage: `Unknown mesh tool: ${body?.tool}` })
  }
})
