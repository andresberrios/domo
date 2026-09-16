import { createVoiceSession } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ title?: string }>(event).catch(() => ({} as { title?: string }))
  return createVoiceSession({ title: body?.title })
})
