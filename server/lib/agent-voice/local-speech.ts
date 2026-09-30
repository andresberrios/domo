import { join } from 'node:path'
import { dataDir } from '../paths'
import { base64FromPcm16 } from '../voice/audio'
import { EMPTY_SPEECH_CONTEXT, precedingTextPrompt, type SpeechContext } from './context'
import type { SpeechChunk } from './speech'

/**
 * Speech in and out without a vendor: open models on this machine's CPU.
 *
 * Whisper or Moonshine (both MIT) transcribe and Kokoro (Apache-2.0) speaks,
 * all as ONNX through transformers.js. The weights are fetched from Hugging
 * Face into the data directory the first time they are needed, and never
 * again. Whisper is the default because it takes the conversation as a
 * prompt and makes over a quarter fewer errors on real speech; Moonshine is
 * about eight times faster and hears cold (`TRANSCRIBE_MODELS` has the
 * numbers). Any transformers.js speech-recognition model id works, such as
 * `onnx-community/whisper-base` for languages other than English.
 */
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const WHISPER_PROMPT_CHARS = 700
const WHISPER_PROMPT_TOKENS = 200

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

export async function transcribeLocal(
  samples: Int16Array,
  sampleRate: number,
  model: string,
  language = '',
  context: SpeechContext = EMPTY_SPEECH_CONTEXT
): Promise<string> {
  if (sampleRate !== 16000) throw new Error('the local transcriber takes 16 kHz audio')
  const transcriber = await ensureTranscriber(model)
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 32768
  const whisper = transcriber.model?.config?.model_type === 'whisper'
  // An English-only Whisper refuses a language; a multilingual one guesses without it.
  const options = whisper && language && transcriber.model.generation_config?.is_multilingual
    ? { language, task: 'transcribe' }
    : {}
  const prompt = precedingTextPrompt(context, WHISPER_PROMPT_CHARS)
  if (prompt && whisper) return transcribeWhisperWithPrompt(transcriber, floats, prompt, options)
  const output = await transcriber(floats, options)
  return String(output?.text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Whisper reads a prompt as the transcript of what came before
 * (`<|startofprev|>` … then the usual start tokens), which is how it learns
 * the words and spellings to expect. The transformers.js pipeline has no
 * option for it, so this does what the pipeline does with the prompt in
 * front, and keeps only what was generated after it. Moonshine has no
 * prompt, and is heard cold.
 */
async function transcribeWhisperWithPrompt(
  transcriber: any,
  floats: Float32Array,
  prompt: string,
  options: { language?: string, task?: string }
): Promise<string> {
  const { processor, tokenizer, model } = transcriber
  const { input_features } = await processor(floats)
  const init: number[] = model._retrieve_init_tokens(model._prepare_generation_config(null, options))
  const previous = tokenizer.model.tokens_to_ids.get('<|startofprev|>')
  // Whisper's context is 448 tokens, half of it for the prompt.
  const promptIds: number[] = tokenizer.encode(` ${prompt.trim()}`, { add_special_tokens: false }).slice(-WHISPER_PROMPT_TOKENS)
  const decoderInputIds = [previous, ...promptIds, ...init]
  const output = await model.generate({
    inputs: input_features,
    decoder_input_ids: decoderInputIds,
    max_new_tokens: 440 - decoderInputIds.length
  })
  const sequence: number[] = Array.from(output.tolist()[0] as bigint[], Number)
  const generated = sequence.slice(decoderInputIds.length)
  return String(tokenizer.decode(generated, { skip_special_tokens: true })).replace(/\s+/g, ' ').trim()
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
