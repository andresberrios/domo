import { listAgentSessions } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const { includeArchived } = getQuery(event)
  return listAgentSessions(includeArchived === 'true')
})
