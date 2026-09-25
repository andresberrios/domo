/**
 * Getting the microphone's 16 kHz into a socket that wants 24 kHz.
 *
 * The browser captures at 16 kHz and plays at 24 kHz, and both numbers are
 * fixed in `useVoiceChannel.ts` — playback in particular builds every
 * `AudioBuffer` at 24 kHz and ignores the rate the server labels a chunk with.
 * Gemini Live happens to want exactly that pair. **GPT-Live takes one rate for
 * both directions**, so a provider switch either changes what the browser does
 * or is absorbed here.
 *
 * It is absorbed here, at 24 kHz, for two reasons. The browser keeps one code
 * path and one capture graph whichever provider is configured — a conversation
 * that switches provider mid-way (the setting is read at every connect) must
 * not need the tab to do anything. And the choice of *which* rate then falls
 * the right way: at 16 kHz both directions would avoid this function, but the
 * spoken output would come back at 16 kHz, which is the half a listener can
 * hear the difference in.
 *
 * Upsampling adds no aliasing — there is nothing above the source's Nyquist to
 * fold — so linear interpolation is enough; what it costs is a little imaging
 * above 8 kHz, in audio that is about to be transcribed and was band-limited
 * at 8 kHz anyway.
 */

/** Little-endian PCM16, which is what both providers and the worklet speak. */
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
 * Chunk-at-a-time and stateless, which is a real approximation: the sample
 * either side of a chunk boundary is interpolated against the chunk's own last
 * sample rather than the next chunk's first. At 16 kHz that is one sample in
 * 1024 of a continuous speech stream, inaudible and invisible to a
 * transcriber; carrying a sample of state across calls would make this
 * per-connection rather than pure, which is a worse trade for what it buys.
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

/** The same, on the base64 the WebSocket carries. */
export function resampleBase64Pcm16(base64: string, from: number, to: number): string {
  if (from === to) return base64
  return base64FromPcm16(resamplePcm16(pcm16FromBase64(base64), from, to))
}
