import { listVoiceMessages } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { limit } = getQuery(event)
  return listVoiceMessages(id, Math.min(Number(limit) || 500, 2000))
})
