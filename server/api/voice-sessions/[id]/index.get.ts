import { getVoiceSession } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const session = await getVoiceSession(id)
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Voice session not found' })
  return session
})
