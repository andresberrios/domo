import { spawn } from 'node:child_process'

import { VOICE_SAMPLE_MAX_SECONDS, VOICE_SAMPLE_RATE } from '../../../shared/agent-voice'
import { wavFromPcm16 } from './speech'

/**
 * A voice sample from whatever audio an agent found, as Pocket reads it:
 * mono PCM16 at 24 kHz, a stretch of at most 30 s.
 *
 * WAV is decoded here, whatever its channels, bit depth or rate, so nothing
 * has to be installed for it. Anything else (FLAC, MP3, Ogg, M4A) goes
 * through `ffmpeg` when it is on the PATH, and is refused with that said
 * when it is not.
 */

export interface SampleWindow {
  /** Where the stretch starts, in seconds. */
  startSeconds?: number
  /** How long it is; at most 30 s. */
  seconds?: number
}

const DEFAULT_SECONDS = 20

function window(input: SampleWindow): { start: number, length: number } {
  const start = Math.max(0, Number(input.startSeconds) || 0)
  const length = Math.min(VOICE_SAMPLE_MAX_SECONDS, Math.max(1, Number(input.seconds) || DEFAULT_SECONDS))
  return { start, length }
}

/** Decode a RIFF/WAVE file to mono float samples, or null when it is not one this reads. */
export function decodeWav(bytes: Buffer): { samples: Float32Array, sampleRate: number } | null {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let data: Buffer | null = null
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = bytes.readUInt16LE(body)
      channels = bytes.readUInt16LE(body + 2)
      sampleRate = bytes.readUInt32LE(body + 4)
      bits = bytes.readUInt16LE(body + 14)
      // WAVE_FORMAT_EXTENSIBLE names the real format in its sub-format GUID.
      if (format === 0xFFFE && size >= 40) format = bytes.readUInt16LE(body + 24)
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(bytes.length, body + size))
      break
    }
    offset = body + size + (size % 2)
  }
  if (!data || !channels || !sampleRate) return null
  const width = bits / 8
  const frames = Math.floor(data.length / (width * channels))
  const read: ((at: number) => number) | null
    = format === 1 && bits === 8 ? at => (data!.readUInt8(at) - 128) / 128
      : format === 1 && bits === 16 ? at => data!.readInt16LE(at) / 32768
        : format === 1 && bits === 24 ? at => data!.readIntLE(at, 3) / 8388608
          : format === 1 && bits === 32 ? at => data!.readInt32LE(at) / 2147483648
            : format === 3 && bits === 32 ? at => data!.readFloatLE(at)
              : format === 3 && bits === 64 ? at => data!.readDoubleLE(at)
                : null
  if (!read) return null
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) sum += read((frame * channels + channel) * width)
    samples[frame] = sum / channels
  }
  return { samples, sampleRate }
}

/** Mono float at any rate to PCM16 at Pocket's, cut to the window. Linear: speech loses nothing it needs. */
function toPocket(samples: Float32Array, rate: number, input: SampleWindow): Buffer {
  const { start, length } = window(input)
  const first = Math.floor(start * rate)
  if (first >= samples.length) throw new Error(`The audio is shorter than ${start} s, where the sample was to start.`)
  const ratio = rate / VOICE_SAMPLE_RATE
  const count = Math.min(Math.floor(length * VOICE_SAMPLE_RATE), Math.floor((samples.length - first) / ratio))
  const out = new Int16Array(count)
  for (let i = 0; i < count; i++) {
    const at = first + i * ratio
    const low = Math.floor(at)
    const high = Math.min(low + 1, samples.length - 1)
    const value = samples[low]! + (samples[high]! - samples[low]!) * (at - low)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)))
  }
  return wavFromPcm16(out, VOICE_SAMPLE_RATE)
}

function viaFfmpeg(bytes: Buffer, input: SampleWindow): Promise<Buffer> {
  const { start, length } = window(input)
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-ss', String(start), '-t', String(length), '-ac', '1', '-ar', String(VOICE_SAMPLE_RATE),
      '-f', 's16le', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT'
      ? new Error('The sample is not a WAV, and ffmpeg is not installed to convert it. Give a WAV file, or install ffmpeg.')
      : error))
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not read the sample: ${stderr.trim().split('\n').at(-1) ?? code}`))
      const pcm = Buffer.concat(out)
      resolve(wavFromPcm16(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), VOICE_SAMPLE_RATE))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(bytes)
  })
}

/** Any audio to a Pocket sample. */
export async function pocketSample(bytes: Buffer, input: SampleWindow = {}): Promise<Buffer> {
  const wav = decodeWav(bytes)
  return wav ? toPocket(wav.samples, wav.sampleRate, input) : viaFfmpeg(bytes, input)
}
