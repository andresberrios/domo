import { assertSessionLive } from '../../../lib/acp/retirement'
import { applyAgentSessionPatch, type AgentSessionPatch } from '../../../lib/acp/session-settings'
import { getAgentSession } from '../../../lib/repo'

/**
 * The one endpoint for changing anything about an agent session: title,
 * archived, permission mode, model, or any of the adapter's own settings. All
 * of them may arrive in the same call.
 *
 * What each field means and in what order they are applied is
 * `applyAgentSessionPatch`'s, not this route's — the voice tool and the mesh
 * tool of the same name go through the same function, and the ordering it owns
 * (the live requests before the column writes, `config` after `model` because
 * an adapter publishes its settings per model) is the kind of thing that is
 * wrong the moment it is written down twice.
 *
 * What stays here is the part that differs per surface: resolving the target.
 * This one takes an id from the path and nothing else, because the caller is a
 * browser that already knows exactly which session it is looking at — where
 * voice resolves a fuzzy title and the mesh defaults to the calling agent and
 * refuses to archive it.
 *
 * On a *retired* session only `title` is allowed. The three adapter requests
 * cannot reach a process that no longer exists, and `archived: false` would
 * quietly put a retired session back on the live list without reviving it —
 * unarchiving is not revival, and `POST /revive` is the only door back.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<AgentSessionPatch>(event)

  const session = await getAgentSession(id)
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  if (
    session.retiredAt
    && (body?.modeId || body?.model || body?.config || body?.archived !== undefined)
  ) {
    assertSessionLive(session, 'changing anything but its title')
  }

  await applyAgentSessionPatch(session, body ?? {})
  // The row as it now stands, not the patch's own summary: the browser renders
  // the session, and a mode or model the adapter answered differently about is
  // exactly what it needs back.
  return (await getAgentSession(id))!
})
