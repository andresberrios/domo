import { purgeAgentSession, setAgentSessionArchived } from '../../../lib/agent-sessions'
import { getAgentSession } from '../../../lib/repo'

/**
 * Archive an agent session, or — with `?purge=true` — really destroy it.
 *
 * Archiving is the only thing DELETE does by default, and it keeps the row and
 * the whole transcript. A purge is refused until the session has been archived
 * first, so a record can never be destroyed straight off the live list.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!

  if (getQuery(event).purge === 'true') {
    if (!await purgeAgentSession(id)) {
      throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
    }
    return { ok: true, id, purged: true }
  }

  if (!await getAgentSession(id)) {
    throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  }
  const session = await setAgentSessionArchived(id, true)
  return { ok: true, id, archived: true, session }
})
