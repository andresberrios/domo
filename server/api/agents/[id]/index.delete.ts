import { purgeAgentSession, retireAgentSession } from '../../../lib/session-retention'

/**
 * Retire an agent session — stop it, stand down everything pointed at it, and
 * keep the row and its whole transcript.
 *
 * Deleting used to mean deleting, and the transcript went with it. An agent
 * session is a record of work, so the default is now a tombstone; `?purge=true`
 * is the one way to really destroy one, and it is refused until the session has
 * been retired first, so nothing skips the tombstone by accident.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const purge = getQuery(event).purge === 'true'

  if (purge) {
    if (!await purgeAgentSession(id)) {
      throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
    }
    return { ok: true, id, purged: true }
  }

  const outcome = await retireAgentSession(id, 'user')
  if (!outcome) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  return {
    ok: true,
    id,
    retired: true,
    session: outcome.session,
    cronJobsDisabled: outcome.cronJobsDisabled,
    subscriptionsRemoved: outcome.subscriptionsRemoved,
    permissionsCancelled: outcome.permissionsCancelled
  }
})
