import type { AgentVoiceSettings, AssistantVoice } from '~~/shared/types'
import { VOICE_PREVIEW_TEXT } from '~~/shared/agent-voice'
import { playWav } from '~/utils/barSounds'

/**
 * A voice saying a short line, to hear before choosing it: the bar's voice as
 * the Settings form has it, saved or not, or an assistant's. The device's
 * own voices are spoken here; every other engine on the server
 * (`/api/agent-voice/preview`). `error` says why one could not be heard.
 */
export function useVoicePreview() {
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function play(request: { agentVoice?: AgentVoiceSettings, voice?: AssistantVoice }, volume = 1) {
    error.value = null
    if (!request.voice && request.agentVoice?.speaker === 'browser') {
      speakOnDevice(request.agentVoice.language, volume)
      return
    }
    loading.value = true
    try {
      const wav = await $fetch<ArrayBuffer>('/api/agent-voice/preview', { method: 'POST', body: request, responseType: 'arrayBuffer' })
      await playWav(wav, volume)
    } catch (caught: any) {
      error.value = await reason(caught)
    } finally {
      loading.value = false
    }
  }

  function speakOnDevice(language: string, volume: number) {
    if (!('speechSynthesis' in window)) {
      error.value = 'This browser cannot speak.'
      return
    }
    window.speechSynthesis.cancel()
    const sample = new SpeechSynthesisUtterance(VOICE_PREVIEW_TEXT)
    const voice = deviceVoice(language)
    if (voice) {
      sample.voice = voice
      sample.lang = voice.lang
    }
    sample.volume = volume
    window.speechSynthesis.speak(sample)
  }

  return { loading, error, play }
}

/** An arrayBuffer request's error body arrives as bytes, not as parsed JSON. */
async function reason(caught: any): Promise<string> {
  const data = caught?.data
  try {
    const parsed = data instanceof ArrayBuffer ? JSON.parse(new TextDecoder().decode(data)) : data
    if (parsed?.message) return parsed.message
  } catch {
    /* not JSON */
  }
  return caught?.message ?? String(caught)
}
