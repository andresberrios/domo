/**
 * The device's own voices, for when "This device" reads replies out.
 *
 * Which voice is chosen matters more than anything else about them: every
 * device has a robotic default and, often, a far better one installed beside
 * it (Apple's Premium, Enhanced and Siri voices, Edge's online "Natural"
 * ones, Chrome's Google voices). The choice is per device, since voices are,
 * and kept in this browser rather than in Settings.
 */
export const DEVICE_VOICE_KEY = 'domo:agent-voice:device-voice'

function quality(voice: SpeechSynthesisVoice): number {
  const name = voice.name
  if (/natural|neural|premium|siri/i.test(name)) return 3
  if (/enhanced|google/i.test(name)) return 2
  if (!voice.localService) return 1
  return 0
}

/** The voices for a language, best first. `language` is an ISO 639-1 code, or '' for any. */
export function rankDeviceVoices(voices: SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice[] {
  const code = (language || 'en').toLowerCase()
  const preferred = navigator.language.toLowerCase()
  return voices
    .filter(voice => voice.lang.toLowerCase().startsWith(code))
    .sort((a, b) => quality(b) - quality(a)
      || Number(b.lang.toLowerCase() === preferred) - Number(a.lang.toLowerCase() === preferred)
      || Number(b.default) - Number(a.default))
}

export function storedDeviceVoice(): string {
  try {
    return window.localStorage.getItem(DEVICE_VOICE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function storeDeviceVoice(name: string) {
  try {
    window.localStorage.setItem(DEVICE_VOICE_KEY, name)
  } catch {
    /* private mode */
  }
}

/** The voice to speak with: the one chosen on this device, else the best for the language. */
export function deviceVoice(language: string): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  const voices = window.speechSynthesis.getVoices()
  const chosen = storedDeviceVoice()
  return voices.find(voice => voice.name === chosen) ?? rankDeviceVoices(voices, language)[0] ?? null
}
