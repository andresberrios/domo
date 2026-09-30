import { CLONED_VOICE_PREFIX } from '../../../../../shared/agent-voice'
import { synthesizePocket } from '../../../../lib/agent-voice/pocket-speech'
import { wavFromPcm16 } from '../../../../lib/agent-voice/speech'
import { getClonedVoice } from '../../../../lib/agent-voice/voice-store'
import { getSettings } from '../../../../lib/settings'

const PREVIEW = 'Hello! This is how I will sound when I read your agent\'s replies.'

/**
 * A cloned voice saying one sentence, as a WAV, through the same request the
 * voice bar makes. Settings plays it right after a voice is kept: the user
 * hears the clone, a missing cloning weight is reported there instead of on
 * the first reply, and Pocket has encoded the sample by the time it is used.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  if (!await getClonedVoice(id)) throw createError({ statusCode: 404, statusMessage: 'No such voice.' })
  const { agentVoice } = await getSettings()
  const pieces: Buffer[] = []
  let rate = 24000
  try {
    await synthesizePocket(PREVIEW, `${CLONED_VOICE_PREFIX}${id}`, agentVoice.pocketUrl, (chunk) => {
      rate = chunk.sampleRate
      pieces.push(Buffer.from(chunk.data, 'base64'))
    })
  } catch (error) {
    throw createError({ statusCode: 502, statusMessage: error instanceof Error ? error.message : String(error) })
  }
  const pcm = Buffer.concat(pieces)
  setResponseHeader(event, 'content-type', 'audio/wav')
  return wavFromPcm16(new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length)), rate)
})
