import { acpManager } from '../../../lib/acp/manager'
import { assertSessionLive } from '../../../lib/acp/retirement'
import { getAgentSession, updateAgentSession } from '../../../lib/repo'

/**
 * The one endpoint for changing anything about an agent session: title,
 * archived, permission mode, model, or any of the adapter's own settings.
 * `modeId`, `model` and `config` go through the live adapter connection
 * (`session/set_mode` / `session/set_config_option`) because those are
 * requests to the running process, not plain column writes; `title` and
 * `archived` are written straight to the row. All of them may arrive in the
 * same call, and `config` is applied after `model` because an adapter
 * publishes its settings per model.
 *
 * On a *retired* session only `title` is allowed. The three adapter requests
 * cannot reach a process that no longer exists, and `archived: false` would
 * quietly put a retired session back on the live list without reviving it —
 * unarchiving is not revival, and `POST /revive` is the only door back.
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

  const existing = await getAgentSession(id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  if (
    existing.retiredAt
    && (body?.modeId || body?.model || body?.config || body?.archived !== undefined)
  ) {
    assertSessionLive(existing, 'changing anything but its title')
  }

  if (body?.modeId) await acpManager.setMode(id, body.modeId)
  if (body?.model) await acpManager.setModel(id, body.model)
  for (const [configId, value] of Object.entries(body?.config ?? {})) {
    await acpManager.setConfigOption(id, configId, value)
  }

  const { modeId: _modeId, model: _model, config: _config, ...columns } = body ?? {}
  const session = Object.keys(columns).length
    ? await updateAgentSession(id, columns)
    : await getAgentSession(id)
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  return session
})
