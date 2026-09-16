import { deleteVoiceSession } from '../../../lib/repo'
import { voiceManager } from '../../../lib/voice/runtime'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await voiceManager.close(id)
  await deleteVoiceSession(id)
  return { ok: true }
})
