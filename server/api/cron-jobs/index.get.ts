import { listCronJobs } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const agentSessionId = getQuery(event).agentSessionId
  return listCronJobs(typeof agentSessionId === 'string' ? agentSessionId : undefined)
})
