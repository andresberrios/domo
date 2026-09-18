import { updateVoiceSession } from '../../../lib/repo'
import { voiceManager } from '../../../lib/voice/runtime'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ title?: string, autoTitle?: boolean, archived?: boolean, voice?: string, model?: string }>(event)
  const { autoTitle, ...patch } = body ?? {}
  // A title typed by the user is final until they hand naming back to Domo.
  const titleSource = autoTitle ? 'auto' as const : patch.title !== undefined ? 'user' as const : undefined
  const session = await updateVoiceSession(id, { ...patch, titleSource })
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Voice session not found' })
  // The live model was told this title was the user's; tell it naming is its job again.
  if (autoTitle) {
    void voiceManager.peek(id)?.injectNote(
      'The user handed naming back to you. Call set_conversation_title with a title for what this conversation is about. Don\'t mention it.',
      false
    ).catch(() => {})
  }
  return session
})
