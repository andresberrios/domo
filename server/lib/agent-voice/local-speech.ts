import { join } from 'node:path'
import { dataDir } from '../paths'
import { base64FromPcm16 } from '../voice/audio'
import type { SpeechChunk } from './speech'

/**
 * Speech in and out without a vendor: open models on this machine's CPU.
 *
 * Moonshine (MIT) transcribes and Kokoro (Apache-2.0) speaks, both as ONNX
 * through transformers.js. Measured here on an arm64 container: a
 * five-second clip transcribed in about a quarter of a second, and the first
 * sentence of speech ready in about a second and a half, then faster than it
 * plays. The weights are fetched from Hugging Face into the data directory
 * the first time they are needed (roughly 300 MB), and never again.
 *
 * Moonshine over Whisper because it is four times faster here at the same
 * accuracy on these clips; the setting can name any transformers.js
 * speech-recognition model, such as `onnx-community/whisper-base` for
 * languages other than English.
 */
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'

let transformers: Promise<typeof import('@huggingface/transformers')> | null = null
const transcribers = new Map<string, Promise<any>>()
let speaker: Promise<any> | null = null

async function lib() {
  if (!transformers) {
    transformers = import('@huggingface/transformers').then((module) => {
      module.env.cacheDir = join(dataDir(), 'models', 'hf')
      return module
    })
  }
  return transformers
}

async function ensureTranscriber(model: string): Promise<any> {
  let loading = transcribers.get(model)
  if (!loading) {
    loading = lib().then(({ pipeline }) => {
      console.log(`[agent-voice] loading the local transcriber ${model}`)
      return pipeline('automatic-speech-recognition', model, { dtype: 'q8', device: 'cpu' } as any)
    })
    transcribers.set(model, loading)
    loading.catch(() => transcribers.delete(model))
  }
  return loading
}

async function ensureSpeaker(): Promise<any> {
  if (!speaker) {
    speaker = (async () => {
      await lib()
      const { KokoroTTS } = await import('kokoro-js')
      console.log(`[agent-voice] loading the local speech model ${KOKORO_MODEL}`)
      return KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu' } as any)
    })()
    speaker.catch(() => { speaker = null })
  }
  return speaker
}

export async function transcribeLocal(samples: Int16Array, sampleRate: number, model: string): Promise<string> {
  if (sampleRate !== 16000) throw new Error('the local transcriber takes 16 kHz audio')
  const transcriber = await ensureTranscriber(model)
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 32768
  const output = await transcriber(floats)
  return String(output?.text ?? '').replace(/\s+/g, ' ').trim()
}

/** Float samples in -1..1 to the PCM16 base64 the socket carries. */
export function pcm16Base64FromFloats(floats: Float32Array): string {
  const pcm = new Int16Array(floats.length)
  for (let i = 0; i < floats.length; i++) {
    const clamped = Math.max(-1, Math.min(1, floats[i]!))
    pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
  }
  return base64FromPcm16(pcm)
}

/**
 * Speak `text`, one sentence at a time as Kokoro finishes each, so the first
 * words play while the rest is still being made.
 */
export async function synthesizeLocal(
  text: string,
  voice: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const model = await ensureSpeaker()
  const { TextSplitterStream } = await import('kokoro-js')
  const splitter = new TextSplitterStream()
  const stream = model.stream(splitter, { voice })
  splitter.push(text)
  splitter.close()
  for await (const piece of stream) {
    if (signal?.aborted) return
    const audio = piece?.audio
    if (!audio?.audio?.length) continue
    onChunk({ data: pcm16Base64FromFloats(audio.audio), sampleRate: audio.sampling_rate ?? 24000 })
  }
}
