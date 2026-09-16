import { updateVoiceSession } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ title?: string, archived?: boolean, voice?: string, model?: string }>(event)
  const session = await updateVoiceSession(id, body ?? {})
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Voice session not found' })
  return session
})
