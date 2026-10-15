import { join } from 'node:path'
import { fetchModelFile } from './model-file'

/**
 * Is anyone speaking in this audio?
 *
 * A transcriber asked to write down noise writes something anyway. Measured
 * October 2026 on room noise, hiss and mains hum of one to four seconds,
 * gemini-3.5-flash returned a whole sentence for most of them, with or
 * without context and whatever the instruction ("No, don't commit yet.",
 * "Great. Now do the same for Jupiter."), and those went to the agent as the
 * developer's words. Silero VAD v5 (snakers4/silero-vad, MIT, a 2 MB ONNX
 * model) put every one of those clips at p(speech) 0.06 or less and every
 * spoken one, "Hmm." and whispers included, at 0.94 or more, in about 12 ms
 * per second of audio on the CPU.
 *
 * It reads 32 ms windows (512 samples at 16 kHz) with the 64 samples before
 * each and a recurrent state, as the reference `OnnxWrapper` does. The model
 * file is fetched from Hugging Face on first use into the data directory;
 * without it, nothing is held back. This runs in the local models' process;
 * the server asks through `voicedSeconds` in `local-speech.ts`.
 */

const SAMPLE_RATE = 16000
const WINDOW = 512
const CONTEXT = 64
/** The reference threshold for a window to be speech. */
const SPEECH_PROBABILITY = 0.5
const MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx'
const MODEL_FILE = 'silero-vad-v5.onnx'

/** The model file, fetched if it is not there yet. Exported for the warm-up. */
export function ensureVadModel(modelsDir: string): Promise<string> {
  return fetchModelFile(MODEL_URL, join(modelsDir, MODEL_FILE), 'the speech detector')
}

let session: Promise<any> | null = null

function ensureSession(modelsDir: string): Promise<any> {
  if (!session) {
    session = (async () => {
      const ort = await import('onnxruntime-node')
      return ort.InferenceSession.create(await ensureVadModel(modelsDir), {
        executionMode: 'sequential',
        interOpNumThreads: 1,
        intraOpNumThreads: 1
      })
    })()
    session.catch((error) => {
      console.warn(`[agent-voice] the speech detector is unavailable, every recording is transcribed: ${error instanceof Error ? error.message : error}`)
      session = null
    })
  }
  return session
}

/**
 * Seconds of speech in `samples` (16 kHz PCM16), counted up to `enough`,
 * where it stops looking. `null` when the model cannot be had.
 */
export async function speechSeconds(samples: Int16Array, modelsDir: string, enough: number): Promise<number | null> {
  let model: any
  try {
    model = await ensureSession(modelsDir)
  } catch {
    return null
  }
  const ort = await import('onnxruntime-node')
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [])
  let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  const input = new Float32Array(CONTEXT + WINDOW)
  let speech = 0
  for (let start = 0; start + WINDOW <= samples.length && speech < enough; start += WINDOW) {
    // The last 64 samples of the window before lead this one.
    input.copyWithin(0, WINDOW)
    for (let i = 0; i < WINDOW; i++) input[CONTEXT + i] = samples[start + i]! / 32768
    const output = await model.run({ input: new ort.Tensor('float32', input.slice(), [1, CONTEXT + WINDOW]), state, sr })
    state = output.stateN
    if (Number(output.output.data[0]) >= SPEECH_PROBABILITY) speech += WINDOW / SAMPLE_RATE
  }
  return speech
}
