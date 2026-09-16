import { voiceManager } from '../../../lib/voice/runtime'

/** Type at the voice agent instead of talking to it. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ text: string }>(event)
  const text = (body?.text ?? '').trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: 'text is required' })
  const runtime = voiceManager.get(id)
  await runtime.ensureConnected()
  await runtime.sendText(text)
  return { ok: true }
})
