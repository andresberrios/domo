import { CLONED_VOICE_PREFIX, DEFAULT_AGENT_VOICE } from '../../../../shared/agent-voice'
import { deleteClonedVoice } from '../../../lib/agent-voice/voice-store'
import { getSettings, patchSettings } from '../../../lib/settings'

/**
 * Forget a cloned voice. If it was the voice in use, Pocket goes back to the
 * default, so the next reply is spoken rather than failing on a missing file.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  if (!await deleteClonedVoice(id)) throw createError({ statusCode: 404, statusMessage: 'No such voice.' })
  const { agentVoice } = await getSettings()
  if (agentVoice.pocketVoice === `${CLONED_VOICE_PREFIX}${id}`) {
    await patchSettings({ agentVoice: { ...agentVoice, pocketVoice: DEFAULT_AGENT_VOICE.pocketVoice } })
  }
  return { ok: true }
})
