import { createClonedVoice, MAX_SAMPLE_BYTES } from '../../../lib/agent-voice/voice-store'

/**
 * Keep a voice sample: multipart, `name` and `sample` (mono PCM16 WAV, which
 * the browser makes from a recording or an uploaded file).
 */
export default defineEventHandler(async (event) => {
  // Refused before the body is read, so a huge upload is never buffered.
  const length = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (length > MAX_SAMPLE_BYTES + 64 * 1024) {
    throw createError({ statusCode: 413, statusMessage: 'The sample is too large: 30 s of audio at most.' })
  }
  const parts = await readMultipartFormData(event)
  const name = parts?.find(part => part.name === 'name')?.data.toString('utf8')
  const sample = parts?.find(part => part.name === 'sample')
  if (!sample?.data?.length) throw createError({ statusCode: 400, statusMessage: 'No voice sample was sent.' })
  if (sample.type && !/^audio\/(?:wav|wave|x-wav|vnd\.wave)$/.test(sample.type)) {
    throw createError({ statusCode: 415, statusMessage: 'The sample has to be a WAV file.' })
  }
  try {
    return await createClonedVoice(name, sample.data)
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : String(error) })
  }
})
