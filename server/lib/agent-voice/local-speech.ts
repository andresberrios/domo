import { join } from 'node:path'
import { dataDir } from '../paths'
import { base64FromPcm16 } from '../voice/audio'
import { EMPTY_SPEECH_CONTEXT, precedingTextPrompt, type SpeechContext } from './context'
import type { SpeechChunk } from './speech'
import { takeClause } from './utterance'

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
/** Whisper's input is 30 seconds; a little under leaves room to cut between words. */
const WHISPER_WINDOW_SECONDS = 28

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
      // fp32, not q8: on an arm64 CPU the quantised model is slower (1.4x real time against 1.8x).
      const tts: any = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'fp32', device: 'cpu' } as any)
      const { Tensor, RawAudio } = await lib()
      const perLength = tts.generate_from_ids.bind(tts)
      // kokoro-js's own, but with the style row held still (see KokoroOptions).
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
  if (!whisper) {
    const output = await transcriber(floats)
    return String(output?.text ?? '').replace(/\s+/g, ' ').trim()
  }
  // An English-only Whisper refuses a language; a multilingual one guesses without it.
  const options = language && transcriber.model.generation_config?.is_multilingual
    ? { language, task: 'transcribe' }
    : {}
  // Whisper hears 30 seconds at a time and drops the rest, so a long turn is
  // heard window by window, each primed with the context and the words heard
  // so far, the way Whisper carries text across its own windows.
  let heard = ''
  for (const window of whisperWindows(floats, sampleRate)) {
    const prompt = precedingTextPrompt(
      { ...context, conversation: [context.conversation, heard].filter(Boolean).join('\n') },
      WHISPER_PROMPT_CHARS
    )
    const text = prompt
      ? await transcribeWhisperWithPrompt(transcriber, window, prompt, options)
      : String((await transcriber(window, options))?.text ?? '').replace(/\s+/g, ' ').trim()
    heard = [heard, text].filter(Boolean).join(' ')
  }
  return heard
}

/**
 * A turn cut into windows Whisper can hear whole: at most
 * `WHISPER_WINDOW_SECONDS` each, cut at the quietest tenth of a second in the
 * last third of the window, so the cut falls between words and not in one.
 */
export function whisperWindows(floats: Float32Array, sampleRate: number): Float32Array[] {
  const most = Math.floor(WHISPER_WINDOW_SECONDS * sampleRate)
  const frame = Math.floor(sampleRate / 10)
  const windows: Float32Array[] = []
  let start = 0
  while (floats.length - start > most) {
    let cut = start + most
    let quietest = Infinity
    for (let at = start + Math.floor(most * 2 / 3); at + frame <= start + most; at += frame) {
      let energy = 0
      for (let i = at; i < at + frame; i++) energy += floats[i]! * floats[i]!
      if (energy < quietest) {
        quietest = energy
        cut = at + Math.floor(frame / 2)
      }
    }
    windows.push(floats.subarray(start, cut))
    start = cut
  }
  windows.push(floats.subarray(start))
  return windows
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
 * How Kokoro is driven, which is most of how it sounds.
 *
 * Kokoro's voices are not one voice: each is a table of 510 style vectors,
 * and kokoro-js picks the row by how many phonemes it is asked to say. Each
 * sentence was said with a different row, so the pitch and timbre jumped at
 * every sentence and the answer sounded stitched from different takes. The
 * row is fixed here, for the whole answer (`styleTokens`).
 *
 * The text still goes in pieces, since Kokoro reads at most 510 phonemes and
 * a long piece delays the first word, but as few as fit (`pieceChars`), each
 * trimmed of the silence Kokoro leaves at its edges, faded in and out so a
 * join never clicks, and set apart by one even pause.
 */
export interface KokoroOptions {
  /** The style row every piece is said with; `null` is kokoro-js's own per-length choice. */
  styleTokens: number | null
  /** Sentences are joined into pieces up to this long. The first piece is one sentence, to start soon. */
  pieceChars: number
  /** The pause between pieces, in seconds. */
  pauseSeconds: number
}

export const KOKORO_OPTIONS: KokoroOptions = { styleTokens: 60, pieceChars: 240, pauseSeconds: 0.18 }

const KOKORO_RATE = 24000
const STYLE_DIM = 256
const voiceTables = new Map<string, Promise<Float32Array>>()

async function voiceTable(voice: string): Promise<Float32Array> {
  let table = voiceTables.get(voice)
  if (!table) {
    table = (async () => {
      const { readFile } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      // Where kokoro-js reads them from itself: `voices/` beside its `dist/`.
      // Resolved as an import, since a build ships only its ESM entry.
      const entry = fileURLToPath(import.meta.resolve('kokoro-js'))
      const bytes = await readFile(join(dirname(entry), '..', 'voices', `${voice}.bin`))
      return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    })()
    voiceTables.set(voice, table)
    table.catch(() => voiceTables.delete(voice))
  }
  return table
}

/** Kokoro's own sentence splitter, for pieces that end where sentences do. */
async function sentencesOf(text: string): Promise<string[]> {
  const { TextSplitterStream } = await import('kokoro-js')
  const splitter = new TextSplitterStream()
  splitter.push(text)
  return [...splitter]
}

/**
 * Sentences joined into pieces up to `pieceChars`. The first piece is short,
 * one sentence or the first clause of a long one, because Kokoro makes a
 * piece in about half its spoken length and the first word waits for it.
 */
export function piecesOf(sentences: string[], pieceChars: number): string[] {
  const pieces: string[] = []
  const [head, ...tail] = sentences
  const clause = head && head.length > 60 ? takeClause(head) : null
  const ordered = clause ? [clause.clause, clause.rest, ...tail] : sentences
  for (const sentence of ordered) {
    const last = pieces.at(-1)
    if (pieces.length > 1 && last && last.length + sentence.length + 1 <= pieceChars) pieces[pieces.length - 1] = `${last} ${sentence}`
    else pieces.push(sentence)
  }
  return pieces
}

/** The style row the next piece is said with. Read by the override in `ensureSpeaker`. */
let styleTokens: number | null = KOKORO_OPTIONS.styleTokens

/** Audio with its leading and trailing near-silence cut, and short fades so the edges never click. */
export function trimmed(audio: Float32Array, rate: number): Float32Array {
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

/**
 * Speak `text` piece by piece as Kokoro finishes each, so the first words
 * play while the rest is still being made.
 */
export async function synthesizeLocal(
  text: string,
  voice: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal,
  options: KokoroOptions = KOKORO_OPTIONS
): Promise<void> {
  const model = await ensureSpeaker()
  const pieces = piecesOf(await sentencesOf(text), options.pieceChars)
  for (const [index, piece] of pieces.entries()) {
    if (signal?.aborted) return
    styleTokens = options.styleTokens
    const audio: Float32Array = (await model.generate(piece, { voice })).audio
    if (signal?.aborted) return
    const clip = trimmed(audio, KOKORO_RATE)
    const pause = index < pieces.length - 1 ? Math.floor(options.pauseSeconds * KOKORO_RATE) : 0
    const out = new Float32Array(clip.length + pause)
    out.set(clip)
    onChunk({ data: pcm16Base64FromFloats(out), sampleRate: KOKORO_RATE })
  }
}
