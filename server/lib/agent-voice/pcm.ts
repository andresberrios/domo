/** The rate the browser captures the microphone at, fixed in `useAgentVoice`. */
export const CLIENT_INPUT_SAMPLE_RATE = 16000

/** Little-endian PCM16, which is what the browser's worklet and the engines speak. */
export function pcm16FromBase64(base64: string): Int16Array {
  const bytes = Buffer.from(base64, 'base64')
  // An odd byte count is half a sample; PCM chunks must contain whole ones, so
  // the stray byte is dropped rather than shifting every sample after it.
  const samples = new Int16Array(bytes.length >> 1)
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2)
  return samples
}

export function base64FromPcm16(samples: Int16Array): string {
  const bytes = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(samples[i]!, i * 2)
  return bytes.toString('base64')
}

/**
 * Resample mono PCM16 by linear interpolation.
 *
 * Stateless, which is a real approximation for audio cut into chunks: the
 * sample either side of a boundary is interpolated against the chunk's own
 * last sample rather than the next chunk's first. Inaudible, and invisible to
 * a transcriber.
 */
export function resamplePcm16(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to || !samples.length) return samples
  const ratio = from / to
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Int16Array(length)
  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = samples[index] ?? 0
    const b = samples[index + 1] ?? a
    out[i] = Math.round(a + (b - a) * fraction)
  }
  return out
}
