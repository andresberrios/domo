import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FromWorker, LocalModelRequest, ToWorker } from './local-models-host'
import { turnProbability } from './turn'

/**
 * The open speech models, in a process of their own (see
 * `local-models-host.ts` for why): Whisper or Moonshine transcribe, Kokoro
 * speaks, all as ONNX through transformers.js, and Smart Turn judges a pause
 * through `onnxruntime-node`. The weights are fetched from Hugging Face into
 * the data directory the first time they are needed, and never again.
 *
 * Only this process imports a model library. The server keeps what needs no
 * model (`local-speech.ts`): the turn cut into Whisper's windows and the
 * prompt each is heard with, and an answer cut into Kokoro's pieces.
 *
 * Nothing here imports what the server does, other than types: a module the
 * two share becomes a chunk of the server bundle, which can carry Nitro's
 * runtime with it (`modules/local-models.ts` fails the build if it does).
 */

// The IPC channel closes when the process holding it ends, however it ends.
process.on('disconnect', () => process.exit(0))
if (!process.send) {
  console.error('[agent-voice] the local models worker runs as a child of Domo, with an IPC channel')
  process.exit(1)
}

/** `<data>/models`, from the server, which knows where the data directory is. */
const modelsDir = process.argv[2]!
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const WHISPER_PROMPT_TOKENS = 200

let transformers: Promise<typeof import('@huggingface/transformers')> | null = null
const transcribers = new Map<string, Promise<any>>()
let speaker: Promise<any> | null = null

async function lib() {
  if (!transformers) {
    transformers = import('@huggingface/transformers').then((module) => {
      module.env.cacheDir = join(modelsDir, 'hf')
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

async function transcribe(model: string, audio: Float32Array, prompt: string, language: string): Promise<string> {
  const transcriber = await ensureTranscriber(model)
  if (transcriber.model?.config?.model_type !== 'whisper') {
    return String((await transcriber(audio))?.text ?? '').replace(/\s+/g, ' ').trim()
  }
  // An English-only Whisper refuses a language; a multilingual one guesses without it.
  const options = language && transcriber.model.generation_config?.is_multilingual
    ? { language, task: 'transcribe' }
    : {}
  return prompt
    ? transcribeWhisperWithPrompt(transcriber, audio, prompt, options)
    : String((await transcriber(audio, options))?.text ?? '').replace(/\s+/g, ' ').trim()
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

/* ------------------------------- Kokoro ------------------------------ */

/*
 * Kokoro's voices are not one voice: each is a table of 510 style vectors,
 * and kokoro-js picks the row by how many phonemes it is asked to say. Each
 * sentence was said with a different row, so the pitch and timbre jumped at
 * every sentence and the answer sounded stitched from different takes. The
 * row is held still here, for the whole answer (`styleTokens`), and each
 * piece is trimmed of the silence Kokoro leaves at its edges, faded in and
 * out so a join never clicks, and set apart by one even pause.
 */

const KOKORO_RATE = 24000
const STYLE_DIM = 256
const voiceTables = new Map<string, Promise<Float32Array>>()
/** The style row the next piece is said with. Read by the override in `ensureSpeaker`. */
let styleTokens: number | null = null

async function ensureSpeaker(): Promise<any> {
  if (!speaker) {
    speaker = (async () => {
      const { Tensor, RawAudio } = await lib()
      const { KokoroTTS } = await import('kokoro-js')
      console.log(`[agent-voice] loading the local speech model ${KOKORO_MODEL}`)
      // fp32, not q8: on an arm64 CPU the quantised model is slower (1.4x real time against 1.8x).
      const tts: any = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'fp32', device: 'cpu' } as any)
      const perLength = tts.generate_from_ids.bind(tts)
      // kokoro-js's own, but with the style row held still.
      tts.generate_from_ids = async (ids: any, { voice, speed = 1 }: { voice: string, speed?: number }) => {
        if (styleTokens === null) return perLength(ids, { voice, speed })
        const table = await voiceTable(voice)
        const row = Math.min(509, styleTokens) * STYLE_DIM
        const { waveform } = await tts.model({
          input_ids: ids,
          style: new Tensor('float32', table.slice(row, row + STYLE_DIM), [1, STYLE_DIM]),
          speed: new Tensor('float32', [speed], [1])
        })
        return new RawAudio(waveform.data, KOKORO_RATE)
      }
      return tts
    })()
    speaker.catch(() => { speaker = null })
  }
  return speaker
}

async function voiceTable(voice: string): Promise<Float32Array> {
  let table = voiceTables.get(voice)
  if (!table) {
    table = (async () => {
      const bytes = await readFile(join(kokoroVoicesDir(), `${voice}.bin`))
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    })()
    voiceTables.set(voice, table)
    table.catch(() => voiceTables.delete(voice))
  }
  return table
}

/**
 * Where kokoro-js keeps its voices: `node_modules/kokoro-js/voices`, found by
 * walking up from this file. Neither resolver can say: require finds the
 * CommonJS entry a build does not ship, and Nitro's bundle has no
 * import.meta.resolve.
 */
function kokoroVoicesDir(): string {
  const starts = [process.argv[1] ? dirname(process.argv[1]) : null, process.cwd()].filter(Boolean) as string[]
  for (const start of starts) {
    for (let dir = start; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', 'kokoro-js', 'voices')
      if (existsSync(candidate)) return candidate
      if (dirname(dir) === dir) break
    }
  }
  throw new Error('kokoro-js voices not found beside the server')
}

/** Kokoro's own sentence splitter, for pieces that end where sentences do. */
async function sentencesOf(text: string): Promise<string[]> {
  const { TextSplitterStream } = await import('kokoro-js')
  const splitter = new TextSplitterStream()
  splitter.push(text)
  return [...splitter]
}

/** Audio with its leading and trailing near-silence cut, and short fades so the edges never click. */
function trimmed(audio: Float32Array, rate: number): Float32Array {
  const threshold = 0.01
  let start = 0
  let end = audio.length
  while (start < end && Math.abs(audio[start]!) < threshold) start++
  while (end > start && Math.abs(audio[end - 1]!) < threshold) end--
  // Keep a breath either side, so a word's soft onset or tail is not shaved.
  start = Math.max(0, start - Math.floor(rate * 0.03))
  end = Math.min(audio.length, end + Math.floor(rate * 0.05))
  const out = audio.slice(start, end)
  const fade = Math.min(Math.floor(rate * 0.008), Math.floor(out.length / 2))
  for (let i = 0; i < fade; i++) {
    out[i]! *= i / fade
    out[out.length - 1 - i]! *= i / fade
  }
  return out
}

/** Float samples in -1..1, and a pause after them, as PCM16. */
function pcm16(floats: Float32Array, pauseSamples: number): Int16Array {
  const pcm = new Int16Array(floats.length + pauseSamples)
  for (let i = 0; i < floats.length; i++) {
    const clamped = Math.max(-1, Math.min(1, floats[i]!))
    pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
  }
  return pcm
}

/** Speak piece by piece, each sent as Kokoro finishes it, so the first words play while the rest is made. */
async function speak(id: string, pieces: string[], voice: string, style: number | null, pauseSeconds: number): Promise<void> {
  const model = await ensureSpeaker()
  for (const [index, piece] of pieces.entries()) {
    if (aborted.has(id)) return
    styleTokens = style
    const audio: Float32Array = (await model.generate(piece, { voice })).audio
    if (aborted.has(id)) return
    const pause = index < pieces.length - 1 ? Math.floor(pauseSeconds * KOKORO_RATE) : 0
    reply({ kind: 'audio', id, pcm: pcm16(trimmed(audio, KOKORO_RATE), pause), sampleRate: KOKORO_RATE })
  }
}

/* ------------------------------ requests ----------------------------- */

const aborted = new Set<string>()

function reply(message: FromWorker) {
  process.send?.(message)
}

async function run(id: string, request: LocalModelRequest): Promise<unknown> {
  switch (request.op) {
    case 'transcriber': {
      const transcriber = await ensureTranscriber(request.model)
      return { whisper: transcriber.model?.config?.model_type === 'whisper' }
    }
    case 'transcribe':
      return transcribe(request.model, request.audio, request.prompt, request.language)
    case 'sentences':
      return sentencesOf(request.text)
    case 'speak':
      return speak(id, request.pieces, request.voice, request.styleTokens, request.pauseSeconds)
    case 'turn':
      return turnProbability(request.samples, modelsDir)
  }
}

process.on('message', (message: ToWorker) => {
  if (message.kind === 'abort') {
    aborted.add(message.id)
    return
  }
  const { id, request } = message
  run(id, request).then(
    value => reply({ kind: 'result', id, value: value ?? null }),
    error => reply({ kind: 'error', id, message: error instanceof Error ? error.message : String(error) })
  ).finally(() => aborted.delete(id))
})
