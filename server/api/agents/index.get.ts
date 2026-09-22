import { listAgentSessions, listRetiredAgentSessions } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const { includeArchived, retired } = getQuery(event)
  // Retired sessions are archived by definition, so they are never in the
  // default answer; asking for them is a different question, not a wider one.
  if (retired === 'true') return listRetiredAgentSessions()
  return listAgentSessions(includeArchived === 'true')
})
