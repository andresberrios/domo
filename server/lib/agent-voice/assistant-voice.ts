import { geminiApiKey } from '../gemini'
import { openAiApiKey } from '../openai'
import { getAssistantOfSession } from '../repo'
import {
  clonedVoiceId,
  CLONED_VOICE_PREFIX,
  GEMINI_VOICES,
  KOKORO_VOICES,
  OPENAI_SPEECH_VOICES,
  POCKET_VOICES,
  SPEAKERS
} from '../../../shared/agent-voice'
import type { AgentVoiceSettings, AssistantVoice, Speaker } from '../../../shared/types'
import { getClonedVoice, listClonedVoices } from './voice-store'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * An assistant speaks with its own voice wherever the voice bar reads it out:
 * its replies, and its notes on whichever bar is open. The voice is an engine
 * and one of that engine's voices; Settings still decide who hears, and how
 * every other agent sounds.
 */

/** Where each engine keeps its voice in `AgentVoiceSettings`. */
const VOICE_FIELD: Record<AssistantVoice['speaker'], keyof AgentVoiceSettings> = {
  gemini: 'geminiVoice',
  openai: 'openaiVoice',
  local: 'localVoice',
  kyutai: 'kyutaiVoice',
  mac: 'macVoice',
  pocket: 'pocketVoice'
}

/** The engines' fixed voice lists; macOS and Kyutai voices depend on the machine or the server. */
const STOCK_VOICES: Partial<Record<AssistantVoice['speaker'], readonly string[]>> = {
  gemini: GEMINI_VOICES,
  openai: OPENAI_SPEECH_VOICES,
  local: KOKORO_VOICES,
  pocket: POCKET_VOICES
}

/** Check an assistant's voice as given by the form or a tool. Null clears it. */
export async function normalizeAssistantVoice(value: unknown): Promise<AssistantVoice | null> {
  if (value === null || value === undefined || value === '') return null
  const input = value as Partial<AssistantVoice>
  const speaker = input?.speaker
  if (!speaker || !(speaker in VOICE_FIELD)) {
    throw new Error(`Unknown speech engine ${String(speaker)}. One of: ${Object.keys(VOICE_FIELD).join(', ')}.`)
  }
  const voice = String(input.voice ?? '').trim()
  if (!voice) throw new Error('Name the voice.')
  const cloned = clonedVoiceId(voice)
  if (cloned) {
    if (speaker !== 'pocket') throw new Error('Cloned voices are spoken by Pocket TTS; set the engine to pocket.')
    if (!await getClonedVoice(cloned)) throw new Error(`No cloned voice ${cloned}. list_voices shows them.`)
    return { speaker, voice }
  }
  const stock = STOCK_VOICES[speaker]
  if (stock && !stock.includes(voice)) {
    throw new Error(`${speaker} has no voice "${voice}". It has: ${stock.join(', ')}.`)
  }
  return { speaker, voice }
}

/**
 * Why this engine cannot speak here, or null when it can. A key that is
 * missing, a machine that is not a Mac, or a Kyutai server nobody chose would
 * fail the first sentence; better to fall back before trying, and to say so
 * in the assistant form. Pocket clones need nothing more than Pocket: Domo
 * fetches the cloning weights itself, and a clone that still fails falls back
 * when it is spoken.
 */
export function speakerUnavailable(speaker: AssistantVoice['speaker'], base: AgentVoiceSettings): string | null {
  switch (speaker) {
    case 'gemini': return geminiApiKey() ? null : 'No Gemini API key. Add one in Settings → Voice.'
    case 'openai': return openAiApiKey() ? null : 'No OpenAI API key. Add one in Settings → Voice.'
    case 'local': return null
    case 'mac': return process.platform === 'darwin' ? null : 'Domo is not running on a Mac.'
    // A server the human runs; only when Settings already point the bar at it.
    case 'kyutai': return base.speaker === 'kyutai' ? null : 'Kyutai speaks only when the voice bar\'s own speaker in Settings → Voice is Kyutai.'
    // Domo starts Pocket itself through uvx, unless Settings name a server.
    case 'pocket': return base.pocketUrl || onPath('uvx') ? null : 'Pocket TTS needs uv on the server, or a Pocket server in Settings → Voice.'
  }
}

function onPath(command: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some(dir => dir && existsSync(join(dir, command)))
}

/**
 * The free voice that can speak here, closest to a device's own first:
 * Apple's voices on a Mac, then Pocket TTS, then Kokoro on the CPU, which
 * runs inside Domo and needs nothing. Null only if none of them can.
 */
export function freeSpeaker(base: AgentVoiceSettings): Speaker | null {
  return (['mac', 'pocket', 'local'] as const).find(speaker => !speakerUnavailable(speaker, base)) ?? null
}

const speakerLabel = (speaker: Speaker) => SPEAKERS.find(entry => entry.id === speaker)?.label ?? speaker

/**
 * The bar's own voice, or, when its engine cannot speak here (a new install
 * has no Gemini key), the free one, with a word for the person about it.
 * When no voice at all can speak, the bar's own is kept, so speaking fails
 * with its reason.
 */
export function barSpeech(base: AgentVoiceSettings): { settings: AgentVoiceSettings, substitute: string | null } {
  const problem = speakerUnavailable(base.speaker, base)
  const free = problem ? freeSpeaker(base) : null
  if (!problem || !free) return { settings: base, substitute: null }
  return {
    settings: { ...base, speaker: free },
    substitute: `${speakerLabel(base.speaker)} cannot speak here (${problem}), so ${speakerLabel(free)} is reading instead.`
  }
}

/**
 * The settings to speak as this session with: the bar's own, with the
 * assistant's engine and voice put in when it has one that can speak here.
 * `fallback` is what to use if speaking with it fails anyway.
 */
export async function speechSettingsFor(
  agentSessionId: string,
  base: AgentVoiceSettings
): Promise<{ settings: AgentVoiceSettings, fallback: AgentVoiceSettings | null, substitute: string | null }> {
  const bar = barSpeech(base)
  const voice = (await getAssistantOfSession(agentSessionId).catch(() => null))?.voice
  if (!voice || speakerUnavailable(voice.speaker, base)) return { settings: bar.settings, fallback: null, substitute: bar.substitute }
  return { settings: withVoice(base, voice), fallback: bar.settings, substitute: null }
}

/** The bar's settings, speaking in this voice instead. */
export function withVoice(base: AgentVoiceSettings, voice: AssistantVoice): AgentVoiceSettings {
  return { ...base, speaker: voice.speaker, [VOICE_FIELD[voice.speaker]]: voice.voice }
}

/** Every voice an assistant could have here, for list_voices. */
export async function voiceCatalog(base: AgentVoiceSettings) {
  const clones = await listClonedVoices()
  return SPEAKERS
    .map(speaker => ({
      engine: speaker.id,
      label: speaker.label,
      usableHere: !speakerUnavailable(speaker.id, base),
      ...speakerUnavailable(speaker.id, base) ? { unavailable: speakerUnavailable(speaker.id, base) } : {},
      ...speaker.id === base.speaker ? { barDefault: base[VOICE_FIELD[speaker.id]] } : {},
      voices: speaker.id === 'pocket'
        ? [...POCKET_VOICES, ...clones.map(clone => `${CLONED_VOICE_PREFIX}${clone.id}`)]
        : STOCK_VOICES[speaker.id] ?? [],
      ...speaker.id === 'pocket' && clones.length
        ? { cloned: clones.map(clone => ({ voice: `${CLONED_VOICE_PREFIX}${clone.id}`, name: clone.name, seconds: clone.seconds })) }
        : {},
      ...speaker.id === 'mac' ? { note: 'Any installed macOS voice identifier; the Settings page lists them.' } : {},
      ...speaker.id === 'kyutai' ? { note: 'A voice file name on the Kyutai server set in Settings.' } : {}
    }))
}
