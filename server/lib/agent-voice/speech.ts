import { GoogleGenAI } from '@google/genai'
import { geminiApiKey } from '../gemini'
import { getSettings } from '../settings'
import type { AgentVoiceSettings } from '../../../shared/types'
import { languageName } from '../../../shared/agent-voice'
import { EMPTY_SPEECH_CONTEXT, instructionPrompt, type SpeechContext } from './context'
import { synthesizeKyutai, transcribeKyutai } from './kyutai-speech'
import { synthesizeLocal, transcribeLocal } from './local-speech'
import { synthesizeMac, transcribeMac } from './mac-speech'
import { synthesizePocket } from './pocket-speech'
import { synthesizeOpenAi, transcribeOpenAi } from './openai-speech'

/**
 * Hearing and speaking, behind two functions. Which engine does either is a
 * setting (`AgentVoiceSettings`), read at each call so a change in Settings
 * applies to the next turn: Gemini's models, OpenAI's endpoints, open models
 * on this CPU, or a Kyutai server. The transcriber and the speaker are
 * chosen separately, so a fast local transcriber can pair with a vendor
 * voice or the other way round.
 *
 * Every engine hands back the same thing: a transcript string, and speech as
 * PCM16 base64 chunks labelled with their sample rate, streamed as soon as
 * they exist.
 */

/**
 * A general model would answer the audio instead of writing it down, so the
 * Gemini request always says what is wanted, and the context comes after it.
 */
const TRANSCRIBE_PROMPT = 'Transcribe the speech verbatim. Output only the transcript, nothing else. '
  + 'If there is no speech, output nothing.'

const CONTEXT_PROMPT = 'The speaker is a software developer talking to their coding agent. '
  + 'Use the context below only to spell names and identifiers the way this project writes them, '
  + 'when they are what was said. Never add words that were not spoken.'

export interface SpeechChunk {
  /** PCM16 base64. */
  data: string
  sampleRate: number
}

function gemini(): GoogleGenAI {
  const apiKey = geminiApiKey()
  if (!apiKey) throw new Error('No Gemini API key: set NUXT_GEMINI_API_KEY')
  return new GoogleGenAI({ apiKey })
}

/** Mono PCM16 with the 44-byte header a transcription request needs. */
export function wavFromPcm16(samples: Int16Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(samples[i]!, 44 + i * 2)
  return wav
}

export function concatPcm16(chunks: Int16Array[]): Int16Array {
  const out = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Whether a recording is worth sending. A click that opened and closed the
 * microphone, or a pause the browser mistook for speech, would otherwise cost
 * a request and come back as a hallucinated word.
 */
export function isSilent(samples: Int16Array, threshold = 300): boolean {
  if (!samples.length) return true
  let sum = 0
  for (let i = 0; i < samples.length; i += 4) sum += samples[i]! * samples[i]!
  return Math.sqrt(sum / Math.ceil(samples.length / 4)) < threshold
}

/** The transcript in a Gemini response, whichever part shape the model used. */
export function transcriptFrom(response: any): string {
  const parts: any[] = response?.candidates?.[0]?.content?.parts ?? []
  return parts
    .map(part => part?.audioTranscription?.text ?? part?.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface TranscribeOptions {
  /** What was said lately and which words exist. Engines that take a prompt are told. */
  context?: SpeechContext
  signal?: AbortSignal
}

/** Hear a turn with the engine chosen in Settings. */
export async function transcribe(
  samples: Int16Array,
  sampleRate: number,
  options: TranscribeOptions = {}
): Promise<string> {
  const { agentVoice } = await getSettings()
  return transcribeWith(agentVoice, samples, sampleRate, options)
}

/**
 * Whether a transcript is the model talking to itself: far more words than
 * anyone says in the time, or one word or phrase over and over. Whisper-style
 * models fall into both when a prompt pulls them off the audio. People
 * stutter too ("the, the, the, the PPAs"), which is why a single word has to
 * repeat far more often than a phrase before it counts.
 */
export function looksHallucinated(text: string, seconds: number): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []
  if (words.length > Math.max(12, seconds * 6)) return true
  for (let size = 1; size <= 4; size++) {
    const limit = size === 1 ? 7 : 3
    for (let start = 0; start < size; start++) {
      let repeats = 0
      for (let i = start + size; i + size <= words.length; i += size) {
        const same = words.slice(i, i + size).join(' ') === words.slice(i - size, i).join(' ')
        repeats = same ? repeats + 1 : 0
        if (repeats >= limit) return true
      }
    }
  }
  return false
}

/**
 * Hear a turn with the given settings. Context makes a recogniser better on
 * average and occasionally much worse: it comes back empty, or loops. Either
 * is heard again without the context, which costs a second request only
 * when it happens.
 */
export async function transcribeWith(
  settings: AgentVoiceSettings,
  samples: Int16Array,
  sampleRate: number,
  { context = EMPTY_SPEECH_CONTEXT, signal }: TranscribeOptions = {}
): Promise<string> {
  const text = await transcribeOnce(settings, samples, sampleRate, context, signal)
  const primed = context.conversation || context.vocabulary.length
  if (!primed || signal?.aborted) return text
  if (text.trim() && !looksHallucinated(text, samples.length / sampleRate)) return text
  // Heard cold, whatever comes back is the best there is.
  return transcribeOnce(settings, samples, sampleRate, EMPTY_SPEECH_CONTEXT, signal)
}

async function transcribeOnce(
  settings: AgentVoiceSettings,
  samples: Int16Array,
  sampleRate: number,
  context: SpeechContext,
  signal?: AbortSignal
): Promise<string> {
  switch (settings.transcriber) {
    case 'local':
      return transcribeLocal(samples, sampleRate, settings.localTranscribeModel, settings.language, context)
    case 'openai':
      return transcribeOpenAi(samples, sampleRate, settings.openaiTranscribeModel, settings.language, context, signal)
    case 'kyutai':
      return transcribeKyutai(samples, sampleRate, settings.kyutaiUrl, signal)
    case 'mac':
      return transcribeMac(samples, sampleRate, settings.language, context)
    case 'browser':
      throw new Error('the browser transcribes its own speech')
  }
  const language = languageName(settings.language)
  const ask = language ? `${TRANSCRIBE_PROMPT} The speech is in ${language}.` : TRANSCRIBE_PROMPT
  const prompt = instructionPrompt(context)
  const response = await gemini().models.generateContent({
    model: settings.geminiTranscribeModel,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: wavFromPcm16(samples, sampleRate).toString('base64') } },
        { text: prompt ? `${ask}\n\n${CONTEXT_PROMPT}\n\n${prompt}` : ask }
      ]
    }],
    // A transcript has one right answer; sampling only adds ways to miss it.
    config: { abortSignal: signal, temperature: 0 }
  })
  return transcriptFrom(response)
}

export function sampleRateOf(mimeType: string | null | undefined): number {
  const match = /rate=(\d+)/.exec(mimeType ?? '')
  return match ? Number(match[1]) : 24000
}

/** A WAV part is PCM behind a header; the browser wants the PCM. */
function pcmOf(inline: { mimeType?: string, data: string }): string {
  if (!/audio\/wav/i.test(inline.mimeType ?? '')) return inline.data
  const bytes = Buffer.from(inline.data, 'base64')
  const at = bytes.indexOf('data', 12, 'ascii')
  return (at >= 0 ? bytes.subarray(at + 8) : bytes.subarray(44)).toString('base64')
}

/**
 * Read `text` out loud, handing each chunk over as it arrives. Streamed, and
 * the caller aborts the stream when the developer interrupts, which is what
 * makes "stop" take effect within a chunk rather than a sentence.
 */
export async function synthesize(
  text: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const { agentVoice, voiceName } = await getSettings()
  return synthesizeWith(agentVoice, voiceName, text, onChunk, signal)
}

/** Speak with the given settings; `voiceName` is the Gemini voice, shared with the live agent. */
export async function synthesizeWith(
  settings: AgentVoiceSettings,
  voiceName: string,
  text: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  switch (settings.speaker) {
    case 'local':
      return synthesizeLocal(text, settings.localVoice, onChunk, signal)
    case 'openai':
      return synthesizeOpenAi(text, settings.openaiSpeechModel, settings.openaiVoice, onChunk, signal)
    case 'kyutai':
      return synthesizeKyutai(text, settings.kyutaiUrl, settings.kyutaiVoice, onChunk, signal)
    case 'mac':
      return synthesizeMac(text, settings.macVoice, settings.language, onChunk, signal)
    case 'pocket':
      return synthesizePocket(text, settings.pocketVoice, settings.pocketUrl, onChunk, signal)
    case 'browser':
      throw new Error('the browser speaks for itself')
  }
  const stream = await gemini().models.generateContentStream({
    model: settings.geminiSpeechModel,
    contents: [{ role: 'user', parts: [{ text }] }],
    config: {
      responseModalities: ['AUDIO' as any],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      abortSignal: signal
    }
  })
  for await (const chunk of stream) {
    if (signal?.aborted) return
    const parts: any[] = (chunk as any)?.candidates?.[0]?.content?.parts ?? []
    for (const part of parts) {
      const inline = part?.inlineData
      if (!inline?.data) continue
      onChunk({ data: pcmOf(inline), sampleRate: sampleRateOf(inline.mimeType) })
    }
  }
}
