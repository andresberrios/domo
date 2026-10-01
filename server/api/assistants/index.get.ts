import { listAssistants } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  return listAssistants(getQuery(event).includeArchived === 'true')
})
