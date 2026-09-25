import type { VoiceDelegationSettings, VoiceProvider, VoiceReasoningEffort } from './types'

/**
 * The two live voice models Domo can talk through, and the small catalogues
 * the Settings page needs to render a picker for either one.
 *
 * Shared rather than server-side because the page has to draw the voice list
 * before it has asked anything: neither provider has an endpoint that lists
 * voices, so these are transcribed from their documentation and are the one
 * place a new voice name gets added. Model *ids* are different — those are
 * listed by an API (`GET /api/models`, `GET /api/openai/live-models`) and only
 * fall back to the default below.
 */
export const VOICE_PROVIDERS: Array<{
  id: VoiceProvider
  label: string
  icon: string
  /** One line under the radio button, so the choice is legible without docs. */
  description: string
}> = [
  {
    id: 'gemini',
    label: 'Gemini Live',
    icon: 'i-lucide-gem',
    description: 'One model listens, thinks and speaks, and calls Domo\'s tools itself.'
  },
  {
    id: 'openai',
    label: 'GPT-Live',
    icon: 'i-lucide-audio-lines',
    description: 'The live model runs the conversation and delegates the thinking.'
  }
]

/** Gemini's prebuilt Live voices. */
export const GEMINI_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']

/** GPT-Live's built-in voices, in the order its reference lists them. */
export const OPENAI_VOICES = [
  'alloy', 'ash', 'ballad', 'beacon', 'bossa', 'cedar', 'cinder', 'coral', 'delta', 'echo',
  'gleam', 'marin', 'meridian', 'quartz', 'ripple', 'sage', 'shimmer', 'stone', 'tempo',
  'verse', 'vesper', 'willow'
]

export const DEFAULT_OPENAI_LIVE_MODEL = 'gpt-live-1'
/** GPT-Live's own default, and the only voice name that is also its default. */
export const DEFAULT_OPENAI_VOICE = 'marin'

/**
 * What the managed backend runs on when nobody has chosen.
 *
 * Sol rather than the cheapest option: this model is the conversation's entire
 * reasoning, and it decides which coding agent to start and what to tell it.
 * Only a default — the Settings card offers every non-live model the key can
 * see and accepts a typed id, because a catalogue pinned here goes stale.
 */
export const DEFAULT_RESPONSES_MODEL = 'gpt-6-sol'

export const REASONING_EFFORTS: VoiceReasoningEffort[]
  = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']

export function isReasoningEffort(value: unknown): value is VoiceReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as string[]).includes(value)
}

export function isVoiceProvider(value: unknown): value is VoiceProvider {
  return value === 'gemini' || value === 'openai'
}

export const DEFAULT_VOICE_DELEGATION: VoiceDelegationSettings = {
  // The managed path, because it is the one that works with nothing else set
  // up: a Responses backend needs a model id and no container, no checkout and
  // no coding agent that might be mid-turn when the user asks a question.
  target: 'responses',
  responsesModel: DEFAULT_RESPONSES_MODEL,
  reasoningEffort: '',
  agentSessionId: '',
  agentAdapter: 'claude-code',
  agentDevEnvironmentId: ''
}
