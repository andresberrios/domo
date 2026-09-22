import { acpManager } from '../../../lib/acp/manager'
import { setAgentSessionArchived } from '../../../lib/agent-sessions'
import { getAgentSession, updateAgentSession } from '../../../lib/repo'

/**
 * The one endpoint for changing anything about an agent session: title,
 * archived, permission mode, model, or any of the adapter's own settings.
 * `modeId`, `model` and `config` go through `AgentRuntime`, which talks to the
 * adapter when one is up and writes the row when it is not — and which refuses
 * outright for a session that can no longer be started, since all three
 * describe how it would run. `title` and `archived` are plain column writes and
 * stay allowed whatever state the session is in: archiving one that cannot run
 * is exactly what you would want to do with it.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{
    title?: string
    archived?: boolean
    modeId?: string
    model?: string
    /** The adapter's own settings, by config option id. */
    config?: Record<string, string>
  }>(event)

  if (body?.modeId) await acpManager.setMode(id, body.modeId)
  if (body?.model) await acpManager.setModel(id, body.model)
  for (const [configId, value] of Object.entries(body?.config ?? {})) {
    await acpManager.setConfigOption(id, configId, value)
  }

  // Archiving stops the adapter, so it goes through `setAgentSessionArchived`
  // rather than being a column write like the title beside it.
  const { modeId: _modeId, model: _model, config: _config, archived, ...columns } = body ?? {}
  if (archived !== undefined) await setAgentSessionArchived(id, archived)
  const session = Object.keys(columns).length
    ? await updateAgentSession(id, columns)
    : await getAgentSession(id)
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  return session
})
