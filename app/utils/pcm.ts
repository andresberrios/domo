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
