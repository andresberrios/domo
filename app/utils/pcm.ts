/**
 * Raw audio the way the two voice channels carry it: mono PCM16 in base64,
 * captured by one AudioWorklet. Shared by `useVoiceChannel` (the live voice
 * agent) and `useAgentVoice` (talking to a coding agent).
 */

/**
 * AudioWorklet that hands raw mono frames to the main thread and reports a
 * level so the UI can show the mic actually hearing something.
 */
export const RECORDER_WORKLET = `
class DomoRecorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.offset = 0
    this.muted = false
    this.port.onmessage = (event) => {
      if (event.data?.type === 'mute') this.muted = !!event.data.value
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true

    let peak = 0
    for (let i = 0; i < input.length; i++) {
      const sample = this.muted ? 0 : input[i]
      peak = Math.max(peak, Math.abs(sample))
      this.buffer[this.offset++] = sample
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ type: 'chunk', samples: this.buffer.slice(0), level: peak }, [])
        this.offset = 0
        peak = 0
      }
    }
    return true
  }
}
registerProcessor('domo-recorder', DomoRecorder)
`

export function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2))
  const floats = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i]! / 0x8000
  return floats
}

/** Mono PCM16 WAV, the one format Domo keeps voice samples in. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Blob([view.buffer], { type: 'audio/wav' })
}

/**
 * Any audio file the browser can decode (a recording, a WAV, an MP3) as a
 * voice sample: mono, at `sampleRate`, and no longer than `maxSeconds`.
 * Decoding into an offline context of that rate is what resamples it.
 */
export async function toVoiceSample(file: ArrayBuffer, sampleRate: number, maxSeconds: number): Promise<{ wav: Blob, seconds: number, trimmed: boolean }> {
  const decoded = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(file)
  const length = Math.min(decoded.length, Math.floor(maxSeconds * sampleRate))
  const mono = new Float32Array(length)
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel)
    for (let i = 0; i < length; i++) mono[i] = mono[i]! + data[i]! / decoded.numberOfChannels
  }
  return { wav: encodeWav(mono, sampleRate), seconds: length / sampleRate, trimmed: decoded.length > length }
}
