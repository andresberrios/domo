import { GoogleGenAI } from '@google/genai'
import { geminiApiKey } from '../gemini'
import { getSettings } from '../settings'
import { synthesizeKyutai, transcribeKyutai } from './kyutai-speech'
import { synthesizeLocal, transcribeLocal } from './local-speech'
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
 * Gemini request always says what is wanted. The transcription model ignores it.
 */
const TRANSCRIBE_PROMPT = 'Transcribe the speech verbatim. Output only the transcript, nothing else. '
  + 'If there is no speech, output nothing.'

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

export async function transcribe(
  samples: Int16Array,
  sampleRate: number,
  signal?: AbortSignal
): Promise<string> {
  const { agentVoice } = await getSettings()
  switch (agentVoice.transcriber) {
    case 'local':
      return transcribeLocal(samples, sampleRate, agentVoice.localTranscribeModel)
    case 'openai':
      return transcribeOpenAi(samples, sampleRate, agentVoice.openaiTranscribeModel, signal)
    case 'kyutai':
      return transcribeKyutai(samples, sampleRate, agentVoice.kyutaiUrl, signal)
  }
  const response = await gemini().models.generateContent({
    model: agentVoice.geminiTranscribeModel,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'audio/wav', data: wavFromPcm16(samples, sampleRate).toString('base64') } },
        { text: TRANSCRIBE_PROMPT }
      ]
    }],
    config: { abortSignal: signal }
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
  switch (agentVoice.speaker) {
    case 'local':
      return synthesizeLocal(text, agentVoice.localVoice, onChunk, signal)
    case 'openai':
      return synthesizeOpenAi(text, agentVoice.openaiSpeechModel, agentVoice.openaiVoice, onChunk, signal)
    case 'kyutai':
      return synthesizeKyutai(text, agentVoice.kyutaiUrl, agentVoice.kyutaiVoice, onChunk, signal)
  }
  const stream = await gemini().models.generateContentStream({
    model: agentVoice.geminiSpeechModel,
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
