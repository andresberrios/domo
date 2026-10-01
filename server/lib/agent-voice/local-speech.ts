import { base64FromPcm16 } from '../voice/audio'
import { EMPTY_SPEECH_CONTEXT, precedingTextPrompt, type SpeechContext } from './context'
import { requestLocalModel } from './local-models'
import type { SpeechChunk } from './speech'
import { takeClause } from './utterance'

/**
 * Speech in and out without a vendor: open models on this machine's CPU.
 *
 * Whisper or Moonshine (both MIT) transcribe and Kokoro (Apache-2.0) speaks,
 * all as ONNX through transformers.js, in a process of their own
 * (`local-models-worker.ts`). Whisper is the default because it takes the
 * conversation as a prompt and makes over a quarter fewer errors on real
 * speech; Moonshine is about eight times faster and hears cold
 * (`TRANSCRIBE_MODELS` has the numbers). Any transformers.js
 * speech-recognition model id works, such as `onnx-community/whisper-base`
 * for languages other than English.
 */
const WHISPER_PROMPT_CHARS = 700
/** Whisper's input is 30 seconds; a little under leaves room to cut between words. */
const WHISPER_WINDOW_SECONDS = 28

export async function transcribeLocal(
  samples: Int16Array,
  sampleRate: number,
  model: string,
  language = '',
  context: SpeechContext = EMPTY_SPEECH_CONTEXT
): Promise<string> {
  if (sampleRate !== 16000) throw new Error('the local transcriber takes 16 kHz audio')
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) floats[i] = samples[i]! / 32768
  const { whisper } = await requestLocalModel<{ whisper: boolean }>({ op: 'transcriber', model })
  if (!whisper) return requestLocalModel<string>({ op: 'transcribe', model, audio: floats, prompt: '', language: '' })
  // Whisper hears 30 seconds at a time and drops the rest, so a long turn is
  // heard window by window, each primed with the context and the words heard
  // so far, the way Whisper carries text across its own windows.
  let heard = ''
  for (const window of whisperWindows(floats, sampleRate)) {
    const prompt = precedingTextPrompt(
      { ...context, conversation: [context.conversation, heard].filter(Boolean).join('\n') },
      WHISPER_PROMPT_CHARS
    )
    const text = await requestLocalModel<string>({ op: 'transcribe', model, audio: window, prompt, language })
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
 * How Kokoro is driven, which is most of how it sounds.
 *
 * Every piece is said with one style row (`styleTokens`), because kokoro-js
 * otherwise picks one by the length of each piece and the voice changed at
 * every sentence (`local-models-worker.ts`). The text still goes in pieces,
 * since Kokoro reads at most 510 phonemes and a long piece delays the first
 * word, but as few as fit (`pieceChars`), set apart by one even pause.
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
  const sentences = await requestLocalModel<string[]>({ op: 'sentences', text })
  if (signal?.aborted) return
  await requestLocalModel({
    op: 'speak',
    pieces: piecesOf(sentences, options.pieceChars),
    voice,
    styleTokens: options.styleTokens,
    pauseSeconds: options.pauseSeconds
  }, {
    signal,
    onAudio: (pcm, sampleRate) => onChunk({ data: base64FromPcm16(pcm), sampleRate })
  })
}

/** Smart Turn's decision threshold, the reference one. */
export const COMPLETE_THRESHOLD = 0.5

/**
 * The probability that the turn in `samples` (16 kHz PCM16, the whole turn so
 * far) is complete, from Smart Turn (`turn.ts`), or `null` when the model
 * cannot be had, which makes a pause end the turn instead.
 */
export async function endOfTurn(samples: Int16Array): Promise<number | null> {
  try {
    return await requestLocalModel<number | null>({ op: 'turn', samples })
  } catch (error) {
    console.warn(`[agent-voice] the turn model failed, pauses end turns instead: ${error instanceof Error ? error.message : error}`)
    return null
  }
}
