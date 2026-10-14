import { PreviewError, previewVoice } from '../../lib/agent-voice/preview'

/** A voice saying a short line, to hear before choosing it. See `previewVoice`. */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ agentVoice?: unknown, voice?: unknown }>(event)
  try {
    const wav = await previewVoice(body ?? {})
    setResponseHeader(event, 'content-type', 'audio/wav')
    return wav
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw createError({ statusCode: error instanceof PreviewError ? 400 : 502, statusMessage: 'Could not speak', message })
  }
})
