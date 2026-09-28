import type { AgentVoiceSettings, SpeechEngine, TurnDetector } from './types'

/**
 * Talking to a coding agent: what the browser and the server both need to know.
 *
 * A spoken turn is delivered to the agent as two text blocks: the developer's
 * words, and a note that they were spoken. The note starts with this prefix
 * so the transcript can hide it and show a microphone instead.
 */
export const SPOKEN_NOTE_PREFIX = '[Spoken over voice]'

export function isSpokenNote(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.startsWith(SPOKEN_NOTE_PREFIX)
}

/** How the browser decides when a spoken turn is over. */
export type AgentVoiceMode = 'click' | 'handsfree'

/**
 * Who can hear and who can speak. Each engine does both, so one list serves
 * the transcriber picker and the speaker picker, and the two can be mixed.
 */
export const SPEECH_ENGINES: Array<{ id: SpeechEngine, label: string, description: string }> = [
  { id: 'local', label: 'On this machine', description: 'Moonshine and Kokoro on the CPU. Free, offline, no key.' },
  { id: 'gemini', label: 'Gemini', description: 'Google\'s transcription and speech models. Needs the Gemini key.' },
  { id: 'openai', label: 'OpenAI', description: 'The transcribe and speech endpoints. Needs the OpenAI key.' },
  { id: 'kyutai', label: 'Kyutai server', description: 'A moshi-server you run, as Unmute does. Needs a GPU.' }
]

export const SPEECH_ENGINE_IDS = SPEECH_ENGINES.map(engine => engine.id)

export function isSpeechEngine(value: unknown): value is SpeechEngine {
  return SPEECH_ENGINE_IDS.includes(value as SpeechEngine)
}

export const TURN_DETECTORS: Array<{ id: TurnDetector, label: string, description: string }> = [
  { id: 'smart-turn', label: 'Smart Turn', description: 'An open model that hears whether the phrase is finished. Runs on the CPU.' },
  { id: 'kyutai', label: 'Kyutai server', description: 'The Kyutai transcriber\'s own pause prediction. Needs the Kyutai server.' },
  { id: 'silence', label: 'Silence', description: 'A pause of a set length ends the turn. Simple, and cuts off a pause to think.' }
]

export function isTurnDetector(value: unknown): value is TurnDetector {
  return TURN_DETECTORS.some(detector => detector.id === value)
}

/** Kokoro v1.0's voices: American and British, female and male. */
export const KOKORO_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis'
]

/** The voices OpenAI's speech endpoint accepts. */
export const OPENAI_SPEECH_VOICES = [
  'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse'
]

export const DEFAULT_AGENT_VOICE: AgentVoiceSettings = {
  transcriber: 'gemini',
  speaker: 'gemini',
  turnDetector: 'smart-turn',
  silenceSeconds: 1.5,
  geminiTranscribeModel: 'gemini-3.5-transcribe',
  geminiSpeechModel: 'gemini-3.8-flash-lite-tts',
  openaiTranscribeModel: 'gpt-4o-mini-transcribe',
  openaiSpeechModel: 'gpt-4o-mini-tts',
  openaiVoice: 'ash',
  localTranscribeModel: 'onnx-community/moonshine-base-ONNX',
  localVoice: 'am_michael',
  kyutaiUrl: 'ws://127.0.0.1:8080',
  kyutaiVoice: 'expresso/ex03-ex01_happy_001_channel1_334s.wav'
}
