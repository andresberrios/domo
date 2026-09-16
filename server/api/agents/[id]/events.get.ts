import { listAgentEvents } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { since } = getQuery(event)
  return listAgentEvents(id, Number(since) || 0)
})
