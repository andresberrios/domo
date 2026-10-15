import { SPEAKERS } from '../../../shared/agent-voice'
import { speakerUnavailable } from '../../lib/agent-voice/assistant-voice'
import { getSettings } from '../../lib/settings'

/** Which engines can speak an assistant's voice here, and why not, for the assistant form. */
export default defineEventHandler(async () => {
  const { agentVoice } = await getSettings()
  return Object.fromEntries(SPEAKERS.map(speaker => [speaker.id, speakerUnavailable(speaker.id, agentVoice)]))
})
