import { describe, expect, it } from 'vitest'

import { decodeWav, pocketSample } from '../../server/lib/agent-voice/sample'
import { parseSampleWav } from '../../server/lib/agent-voice/voice-store'

/** A WAV of a tone, in whatever layout a downloaded sample might come in. */
function wav(input: { rate: number, channels: number, seconds: number, format: 'pcm16' | 'pcm24' | 'float32' }): Buffer {
  const width = input.format === 'pcm16' ? 2 : input.format === 'pcm24' ? 3 : 4
  const frames = Math.round(input.rate * input.seconds)
  const data = Buffer.alloc(frames * input.channels * width)
  for (let frame = 0; frame < frames; frame++) {
    const value = Math.sin((2 * Math.PI * 220 * frame) / input.rate) * 0.5
    for (let channel = 0; channel < input.channels; channel++) {
      const at = (frame * input.channels + channel) * width
      if (input.format === 'pcm16') data.writeInt16LE(Math.round(value * 32767), at)
      else if (input.format === 'pcm24') data.writeIntLE(Math.round(value * 8388607), at, 3)
      else data.writeFloatLE(value, at)
    }
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(input.format === 'float32' ? 3 : 1, 20)
  header.writeUInt16LE(input.channels, 22)
  header.writeUInt32LE(input.rate, 24)
  header.writeUInt32LE(input.rate * input.channels * width, 28)
  header.writeUInt16LE(input.channels * width, 32)
  header.writeUInt16LE(width * 8, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

describe('voice samples', () => {
  it('turns any WAV into the mono 24 kHz PCM16 Pocket reads', async () => {
    for (const layout of [
      { rate: 44100, channels: 2, seconds: 12, format: 'pcm16' as const },
      { rate: 48000, channels: 1, seconds: 12, format: 'pcm24' as const },
      { rate: 16000, channels: 2, seconds: 12, format: 'float32' as const }
    ]) {
      const sample = await pocketSample(wav(layout))
      expect(parseSampleWav(sample)).toEqual({ sampleRate: 24000, seconds: 12 })
      const decoded = decodeWav(sample)!
      // The tone survives: loud, not clipped, not silent.
      const peak = decoded.samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
      expect(peak).toBeGreaterThan(0.4)
      expect(peak).toBeLessThan(0.6)
    }
  })

  it('cuts the stretch asked for, and never more than 30 s', async () => {
    const long = wav({ rate: 24000, channels: 1, seconds: 50, format: 'pcm16' })
    expect(parseSampleWav(await pocketSample(long, { startSeconds: 5, seconds: 8 })).seconds).toBe(8)
    expect(parseSampleWav(await pocketSample(long, { seconds: 90 })).seconds).toBe(30)
    await expect(pocketSample(long, { startSeconds: 60 })).rejects.toThrow('shorter than 60 s')
  })

  it('reads only WAV itself; anything else goes to ffmpeg', () => {
    expect(decodeWav(Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000fake mp3'))).toBeNull()
    expect(decodeWav(Buffer.from('fLaC\u0000\u0000\u0000"'))).toBeNull()
  })
})
