import { listVoiceSessions } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const { includeArchived } = getQuery(event)
  return listVoiceSessions(includeArchived === 'true')
})
