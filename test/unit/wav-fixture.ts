/** A WAV of silence in whatever format a test needs to refuse or accept. */
export function sampleWav(seconds: number, options: { rate?: number, channels?: number, bits?: number, format?: number, extraChunk?: boolean } = {}): Buffer {
  const { rate = 24000, channels = 1, bits = 16, format = 1, extraChunk = false } = options
  const data = Buffer.alloc(Math.round(seconds * rate) * channels * (bits / 8))
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0)
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(format, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(rate, 12)
  fmt.writeUInt32LE(rate * channels * bits / 8, 16)
  fmt.writeUInt16LE(channels * bits / 8, 20)
  fmt.writeUInt16LE(bits, 22)
  // An odd-sized chunk, which RIFF pads to an even length.
  const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([5, 0, 0, 0]), Buffer.from('INFOx'), Buffer.from([0])])
  const dataHeader = Buffer.alloc(8)
  dataHeader.write('data', 0)
  dataHeader.writeUInt32LE(data.length, 4)
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, ...extraChunk ? [list] : [], dataHeader, data])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0)
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}
