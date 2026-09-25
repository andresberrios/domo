import { acpManager } from './acp/manager'
import { deleteAgentSession, getAgentSession, updateAgentSession } from './repo'
import type { AgentSession } from '../../shared/types'

/**
 * A session's own lifecycle, one layer above the adapter manager.
 *
 * `archived` is the single visibility state a session has, and it is only ever
 * about whether it shows up in a list. It deliberately says nothing about
 * whether the session can run — that is derived from the place it ran
 * (`sessionStartability`) and is never stored, so archiving a session whose
 * environment has been retired is a perfectly ordinary thing to do.
 *
 * Archiving stops the adapter, which is why this exists rather than the column
 * being written from each of the three callers: the HTTP route, the voice tool
 * and the mesh tool all used to reach for `updateAgentSession` directly, and
 * two of the three left a live adapter attached to a session that had just
 * vanished from every list.
 */
export async function setAgentSessionArchived(id: string, archived: boolean): Promise<AgentSession | null> {
  if (!archived) return updateAgentSession(id, { archived: false })
  acpManager.stop(id)
  return updateAgentSession(id, { archived: true, status: 'stopped' })
}

/**
 * Really delete a session, transcript and all.
 *
 * The one genuine permanent delete, and it is deliberately only reachable
 * *through* the archive: a record can never be destroyed straight off the live
 * list, and by the time this is offered the session is something the user has
 * already looked at and put away once.
 *
 * It is also what lets the retired rows above a session go — an environment
 * whose last session has been purged has nothing left to say, and neither does
 * the project above that.
 */
export async function purgeAgentSession(id: string): Promise<boolean> {
  const session = await getAgentSession(id)
  if (!session) return false
  if (!session.archived) {
    // `statusCode` is read straight off a thrown Error by h3's `createError`,
    // so the route needs no mapping.
    throw Object.assign(
      new Error(
        `Agent session "${session.title}" (${session.id}) is not archived. `
        + 'Archive it before deleting it permanently — this destroys its transcript.'
      ),
      { statusCode: 409, statusMessage: 'Agent session is not archived' }
    )
  }
  acpManager.stop(id)
  await deleteAgentSession(id)
  return true
}
