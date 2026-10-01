import { listClonedVoices } from '../../../lib/agent-voice/voice-store'

/** The voices cloned for Pocket TTS, oldest first. */
export default defineEventHandler(() => listClonedVoices())
