import { createWriteStream } from 'node:fs'
import { access, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/**
 * Has the developer finished talking?
 *
 * Silence says nothing about that: a pause to think and the end of a thought
 * sound the same to a level meter. Smart Turn (pipecat-ai/smart-turn, BSD-2)
 * answers from the words and the intonation: an 8 M-parameter classifier on
 * a Whisper-tiny front end, given the last eight seconds of the turn, that
 * says whether the phrase is complete. It runs on the CPU in about 25 ms.
 *
 * The features are Whisper's, reproduced here rather than imported: a
 * 400-point STFT at a 160 hop, 80 slaney mel bands, log10, an 8 dB floor
 * under the peak, then `(x + 4) / 4`, on a zero-mean unit-variance waveform
 * padded at the *front* to eight seconds so the speech ends where the model
 * expects it. Every constant is the reference `inference.py`'s, and a change
 * to any of them silently moves the probabilities, so they are not settings.
 *
 * The model file is fetched from Hugging Face on first use into the data
 * directory. An install that cannot reach it gets `null` and the caller falls
 * back to "a long pause ends the turn". This runs in the local models'
 * process (`local-models-worker.ts`); the server asks through `endOfTurn` in
 * `local-speech.ts`.
 */

export const SAMPLE_RATE = 16000
const WINDOW_SECONDS = 8
const WINDOW_SAMPLES = WINDOW_SECONDS * SAMPLE_RATE
const N_FFT = 400
const HOP = 160
const N_MELS = 80
const N_FREQS = N_FFT / 2 + 1
/** Frames the model was exported for: 8 s at a 160 hop, minus Whisper's dropped last frame. */
const N_FRAMES = WINDOW_SAMPLES / HOP

const MODEL_URL = 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx'
const MODEL_FILE = 'smart-turn-v3.2-cpu.onnx'

/* ------------------------------ features ----------------------------- */

function hzToMel(hz: number): number {
  // Slaney: linear below 1 kHz, logarithmic above.
  const minLogHz = 1000
  const minLogMel = 15
  const logStep = Math.log(6.4) / 27
  return hz < minLogHz ? 3 * hz / 200 : minLogMel + Math.log(hz / minLogHz) / logStep
}

function melToHz(mel: number): number {
  const minLogHz = 1000
  const minLogMel = 15
  const logStep = Math.log(6.4) / 27
  return mel < minLogMel ? 200 * mel / 3 : minLogHz * Math.exp(logStep * (mel - minLogMel))
}

/** The 80 × 201 slaney-normalised triangular filter bank, built once. */
function melFilters(): Float32Array[] {
  const melMin = hzToMel(0)
  const melMax = hzToMel(SAMPLE_RATE / 2)
  const points = new Float64Array(N_MELS + 2)
  for (let i = 0; i < points.length; i++) points[i] = melToHz(melMin + (melMax - melMin) * i / (N_MELS + 1))
  const fftFreqs = new Float64Array(N_FREQS)
  for (let k = 0; k < N_FREQS; k++) fftFreqs[k] = (SAMPLE_RATE / 2) * k / (N_FREQS - 1)

  const filters: Float32Array[] = []
  for (let m = 0; m < N_MELS; m++) {
    const lower = points[m]!
    const center = points[m + 1]!
    const upper = points[m + 2]!
    const norm = 2 / (upper - lower)
    const filter = new Float32Array(N_FREQS)
    for (let k = 0; k < N_FREQS; k++) {
      const f = fftFreqs[k]!
      const down = (f - lower) / (center - lower)
      const up = (upper - f) / (upper - center)
      filter[k] = Math.max(0, Math.min(down, up)) * norm
    }
    filters.push(filter)
  }
  return filters
}

/** cos/sin tables for a straight 400-point DFT of the 201 non-negative bins. */
function dftTables(): { cos: Float32Array, sin: Float32Array } {
  const cos = new Float32Array(N_FREQS * N_FFT)
  const sin = new Float32Array(N_FREQS * N_FFT)
  for (let k = 0; k < N_FREQS; k++) {
    for (let n = 0; n < N_FFT; n++) {
      const angle = 2 * Math.PI * k * n / N_FFT
      cos[k * N_FFT + n] = Math.cos(angle)
      sin[k * N_FFT + n] = Math.sin(angle)
    }
  }
  return { cos, sin }
}

/** Periodic Hann, as `np.hanning(N + 1)[:-1]`. */
function hannWindow(): Float32Array {
  const window = new Float32Array(N_FFT)
  for (let n = 0; n < N_FFT; n++) window[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N_FFT)
  return window
}

let tables: { filters: Float32Array[], cos: Float32Array, sin: Float32Array, window: Float32Array } | null = null

function ensureTables() {
  if (!tables) tables = { filters: melFilters(), ...dftTables(), window: hannWindow() }
  return tables
}

/** The last eight seconds, front-padded with zeros, as float samples in -1..1. */
export function windowOf(samples: Int16Array): Float32Array {
  const out = new Float32Array(WINDOW_SAMPLES)
  const take = Math.min(samples.length, WINDOW_SAMPLES)
  const from = samples.length - take
  const to = WINDOW_SAMPLES - take
  for (let i = 0; i < take; i++) out[to + i] = samples[from + i]! / 32768
  return out
}

/**
 * Whisper's log-mel features of one eight-second window, in the shape the
 * model takes: `[80][800]` flattened row-major.
 */
export function logMelFeatures(waveform: Float32Array): Float32Array {
  const { filters, cos, sin, window } = ensureTables()

  // Zero mean, unit variance, over the whole padded window: that is what the
  // reference does, because its padding happens before the extractor sees it.
  let mean = 0
  for (let i = 0; i < waveform.length; i++) mean += waveform[i]!
  mean /= waveform.length
  let variance = 0
  for (let i = 0; i < waveform.length; i++) variance += (waveform[i]! - mean) ** 2
  variance /= waveform.length
  const scale = 1 / Math.sqrt(variance + 1e-7)
  const x = new Float32Array(waveform.length)
  for (let i = 0; i < x.length; i++) x[i] = (waveform[i]! - mean) * scale

  // Centered frames with reflect padding of N_FFT / 2 on both sides.
  const half = N_FFT / 2
  const padded = new Float32Array(x.length + N_FFT)
  for (let i = 0; i < padded.length; i++) {
    let j = i - half
    if (j < 0) j = -j
    else if (j >= x.length) j = 2 * x.length - j - 2
    padded[i] = x[j]!
  }

  const power = new Float32Array(N_FRAMES * N_FREQS)
  const frame = new Float32Array(N_FFT)
  for (let t = 0; t < N_FRAMES; t++) {
    const start = t * HOP
    for (let n = 0; n < N_FFT; n++) frame[n] = padded[start + n]! * window[n]!
    for (let k = 0; k < N_FREQS; k++) {
      let re = 0
      let im = 0
      const base = k * N_FFT
      for (let n = 0; n < N_FFT; n++) {
        re += frame[n]! * cos[base + n]!
        im -= frame[n]! * sin[base + n]!
      }
      power[t * N_FREQS + k] = re * re + im * im
    }
  }

  const features = new Float32Array(N_MELS * N_FRAMES)
  let max = -Infinity
  for (let m = 0; m < N_MELS; m++) {
    const filter = filters[m]!
    for (let t = 0; t < N_FRAMES; t++) {
      let sum = 0
      const row = t * N_FREQS
      for (let k = 0; k < N_FREQS; k++) sum += power[row + k]! * filter[k]!
      const value = Math.log10(Math.max(sum, 1e-10))
      features[m * N_FRAMES + t] = value
      if (value > max) max = value
    }
  }
  const floor = max - 8
  for (let i = 0; i < features.length; i++) features[i] = (Math.max(features[i]!, floor) + 4) / 4
  return features
}

/* ------------------------------- model ------------------------------- */

/** The model file, fetched if it is not there yet. Exported for the warm-up. */
export async function ensureModel(modelsDir: string): Promise<string> {
  const path = process.env.NUXT_SMART_TURN_MODEL || join(modelsDir, MODEL_FILE)
  if (await access(path).then(() => true, () => false)) return path
  await mkdir(dirname(path), { recursive: true })
  console.log(`[agent-voice] fetching the turn model into ${path}`)
  const response = await fetch(MODEL_URL)
  if (!response.ok || !response.body) throw new Error(`could not fetch ${MODEL_URL}: ${response.status}`)
  const partial = `${path}.part`
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(partial))
  await rename(partial, path)
  return path
}

let session: Promise<any> | null = null

async function ensureSession(modelsDir: string): Promise<any> {
  if (!session) {
    session = (async () => {
      const ort = await import('onnxruntime-node')
      return ort.InferenceSession.create(await ensureModel(modelsDir), {
        executionMode: 'sequential',
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all'
      })
    })()
    session.catch((error) => {
      console.warn(`[agent-voice] the turn model is unavailable, pauses end turns instead: ${error instanceof Error ? error.message : error}`)
      session = null
    })
  }
  return session
}

/**
 * The probability that the turn in `samples` (16 kHz PCM16, the whole turn so
 * far) is complete, or `null` when the model cannot be had.
 */
export async function turnProbability(samples: Int16Array, modelsDir: string): Promise<number | null> {
  let model: any
  try {
    model = await ensureSession(modelsDir)
  } catch {
    return null
  }
  const ort = await import('onnxruntime-node')
  const features = logMelFeatures(windowOf(samples))
  const input = new ort.Tensor('float32', features, [1, N_MELS, N_FRAMES])
  const output = await model.run({ input_features: input })
  const logits = output.logits ?? output[Object.keys(output)[0]!]
  return Number(logits.data[0])
}
