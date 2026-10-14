import { VOICE_PREVIEW_TEXT } from '../../../shared/agent-voice'
import type { AgentVoiceSettings } from '../../../shared/types'
import { getSettings, normalizeAgentVoice } from '../settings'
import { normalizeAssistantVoice, speakerUnavailable, withVoice } from './assistant-voice'
import { concatPcm16, synthesizeWith, wavFromPcm16 } from './speech'

/** A voice tried out in Settings or the assistant form; the message is for the person trying it. */
export class PreviewError extends Error {}

/**
 * A short line in a voice, as a WAV: the bar's voice as the Settings form has
 * it (saved or not), or an assistant's voice on top of the saved settings.
 * An assistant's voice that would fall back to the bar's when it speaks is
 * refused with the reason instead, so trying it is never a different voice.
 */
export async function previewVoice(request: { agentVoice?: unknown, voice?: unknown }, signal?: AbortSignal): Promise<Buffer> {
  const base = request.agentVoice ? normalizeAgentVoice(request.agentVoice) : (await getSettings()).agentVoice
  let settings: AgentVoiceSettings = base
  if (request.voice) {
    const voice = await normalizeAssistantVoice(request.voice).catch((error) => { throw new PreviewError(error.message) })
    if (!voice) throw new PreviewError('Choose a voice to hear.')
    const unavailable = speakerUnavailable(voice.speaker, base)
    if (unavailable) throw new PreviewError(`This voice cannot speak here, so the voice bar's own would be used: ${unavailable}`)
    settings = withVoice(base, voice)
  }
  if (settings.speaker === 'browser') throw new PreviewError('The device speaks its own voices; the browser plays them itself.')

  const chunks: Int16Array[] = []
  let sampleRate = 0
  await synthesizeWith(settings, VOICE_PREVIEW_TEXT, (chunk) => {
    // Engines speak one rate for a whole request.
    sampleRate ||= chunk.sampleRate
    const bytes = Buffer.from(chunk.data, 'base64')
    chunks.push(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2))))
  }, signal)
  if (!sampleRate) throw new PreviewError('The engine answered with no audio.')
  return wavFromPcm16(concatPcm16(chunks), sampleRate)
}
