import { macSpeechUnavailable, macVoices } from '../../lib/agent-voice/mac-speech'

/** The voices installed on the Mac Domo runs on, for the "This Mac" speaker's picker. */
export default defineEventHandler(async () => {
  const unavailable = macSpeechUnavailable()
  if (unavailable) return { available: false, reason: unavailable, voices: [] }
  try {
    return { available: true, voices: await macVoices() }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error), voices: [] }
  }
})
