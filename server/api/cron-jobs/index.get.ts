import { listCronJobs } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const { agentSessionId, assistantId, includeArchived } = getQuery(event)
  return listCronJobs({
    agentSessionId: typeof agentSessionId === 'string' ? agentSessionId : undefined,
    assistantId: typeof assistantId === 'string' ? assistantId : undefined
  }, { includeArchived: includeArchived === 'true' || includeArchived === '1' })
})
