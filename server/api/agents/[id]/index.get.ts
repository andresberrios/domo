import { getAgentSession } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const session = await getAgentSession(id)
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  return session
})
