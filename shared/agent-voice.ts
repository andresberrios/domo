import type { AgentVoiceSettings, Speaker, SpeechEngine, ToolSound, Transcriber, TurnDetector } from './types'

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
  { id: 'local', label: 'Open models', description: 'Whisper or Moonshine, and Kokoro, on the server\'s CPU. Free, offline, no key.' },
  { id: 'gemini', label: 'Gemini', description: 'Google\'s transcription and speech models. Needs the Gemini key.' },
  { id: 'openai', label: 'OpenAI', description: 'The transcribe and speech endpoints. Needs the OpenAI key.' },
  { id: 'kyutai', label: 'Kyutai server (untested)', description: 'A moshi-server you run, as Unmute does. Needs a GPU. Never yet run against a real server.' },
  { id: 'mac', label: 'macOS', description: 'Apple\'s own voices and recogniser, when Domo runs on a Mac with macOS 26. Free, local, the fastest: 16.9% errors in 0.2 s, but weaker on names.' }
]

export const SPEECH_ENGINE_IDS = SPEECH_ENGINES.map(engine => engine.id)

export function isSpeechEngine(value: unknown): value is SpeechEngine {
  return SPEECH_ENGINE_IDS.includes(value as SpeechEngine)
}

/**
 * Who can hear: the engines, and the device. The device's own recogniser is
 * Web Speech in the browser, which is Google's in Chrome and Apple's
 * dictation in Safari.
 */
export const TRANSCRIBERS: Array<{ id: Transcriber, label: string, description: string }> = [
  ...SPEECH_ENGINES,
  { id: 'browser', label: 'This device', description: 'The browser\'s own dictation: Google\'s in Chrome, Apple\'s in Safari. Free, no key.' }
]

export function isTranscriber(value: unknown): value is Transcriber {
  return TRANSCRIBERS.some(transcriber => transcriber.id === value)
}

/** Who can speak: the engines, and the device's own voices. */
export const SPEAKERS: Array<{ id: Speaker, label: string, description: string }> = [
  ...SPEECH_ENGINES,
  { id: 'browser', label: 'This device', description: 'The device\'s own voices: instant and free. Siri voices on Apple, natural voices in Edge.' }
]

export function isSpeaker(value: unknown): value is Speaker {
  return SPEAKERS.some(speaker => speaker.id === value)
}

/** What a tool call sounds like, so a phone in a pocket knows the agent is at work. */
export const TOOL_SOUNDS: Array<{ id: ToolSound, label: string, description: string }> = [
  { id: 'typing', label: 'Mechanical keyboard', description: 'A few keys typed, clicky.' },
  { id: 'laptop', label: 'Laptop keys', description: 'Softer, flatter typing.' },
  { id: 'tick', label: 'Tick', description: 'One short tick.' },
  { id: 'off', label: 'Off', description: 'Tool calls are silent.' }
]

export function isToolSound(value: unknown): value is ToolSound {
  return TOOL_SOUNDS.some(sound => sound.id === value)
}

export const TURN_DETECTORS: Array<{ id: TurnDetector, label: string, description: string }> = [
  { id: 'smart-turn', label: 'Smart Turn', description: 'An open model that hears whether the phrase is finished. Runs on the CPU.' },
  { id: 'kyutai', label: 'Kyutai server', description: 'The Kyutai transcriber\'s own pause prediction. Needs the Kyutai server.' },
  { id: 'silence', label: 'Silence', description: 'A pause of a set length ends the turn. Simple, and cuts off a pause to think.' }
]

export function isTurnDetector(value: unknown): value is TurnDetector {
  return TURN_DETECTORS.some(detector => detector.id === value)
}

/** The languages offered in Settings. Every engine here knows these; '' leaves it to the engine. */
export const SPEECH_LANGUAGES: Array<{ id: string, label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Spanish' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'it', label: 'Italian' },
  { id: 'pt', label: 'Portuguese' },
  { id: 'nl', label: 'Dutch' },
  { id: 'ja', label: 'Japanese' },
  { id: 'zh', label: 'Chinese' },
  { id: '', label: 'Detect each turn' }
]

export function languageName(code: string): string | null {
  return SPEECH_LANGUAGES.find(language => language.id === code && code)?.label ?? null
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

/**
 * The transcription models, by what `scripts/stt-bench` measured on 264 clips
 * of real speech (Earnings-22 calls and AMI far-field meetings), each heard
 * with its context. Word error rate over both sets, and median latency here.
 * The first of each engine is its default.
 */
export const TRANSCRIBE_MODELS = {
  gemini: [
    { id: 'gemini-3.5-flash', note: '13.8% errors, 1.7 s. Uses the project\'s words.' },
    { id: 'gemini-3.5-transcribe', note: '14.7% errors, 1.3 s. Ignores context, so misses more names.' }
  ],
  openai: [
    { id: 'whisper-1', note: '13.3% errors, 1.2 s. The most accurate measured.' },
    { id: 'gpt-transcribe', note: '14.5% errors, 0.7 s. The fastest.' },
    { id: 'gpt-4o-mini-transcribe', note: '16.5% errors, 0.7 s.' },
    { id: 'gpt-4o-transcribe', note: '24% errors: garbles noisy speech. Not recommended.' }
  ],
  local: [
    { id: 'onnx-community/whisper-small.en', note: '17.2% errors, about 3.5 s on a 10-core CPU. Uses the project\'s words.' },
    { id: 'onnx-community/moonshine-base-ONNX', note: '23.9% errors, 0.4 s. Fast, and hears no context.' },
    { id: 'onnx-community/whisper-large-v3-turbo', note: 'More accurate still, about 8 s a turn on a CPU.' }
  ]
} as const

export const DEFAULT_AGENT_VOICE: AgentVoiceSettings = {
  transcriber: 'gemini',
  speaker: 'gemini',
  turnDetector: 'smart-turn',
  language: 'en',
  silenceSeconds: 1.5,
  geminiTranscribeModel: 'gemini-3.5-flash',
  geminiSpeechModel: 'gemini-3.8-flash-lite-tts',
  openaiTranscribeModel: 'whisper-1',
  openaiSpeechModel: 'gpt-4o-mini-tts',
  openaiVoice: 'ash',
  localTranscribeModel: 'onnx-community/whisper-small.en',
  localVoice: 'am_michael',
  kyutaiUrl: 'ws://127.0.0.1:8080',
  kyutaiVoice: 'expresso/ex03-ex01_happy_001_channel1_334s.wav',
  macVoice: '',
  toolSound: 'typing'
}
