import { listCronJobs } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const { agentSessionId, assistantId } = getQuery(event)
  return listCronJobs({
    agentSessionId: typeof agentSessionId === 'string' ? agentSessionId : undefined,
    assistantId: typeof assistantId === 'string' ? assistantId : undefined
  })
})
