import { describe, expect, it } from 'vitest'

import { createDownsampler } from '../../app/utils/downsample'

/** The voice bar's fallback for a browser that will not record a microphone at 16 kHz. */
describe('createDownsampler', () => {
  it('turns 48 kHz into 16 kHz frames, across chunk boundaries, keeping the level', () => {
    const down = createDownsampler(48000, 16000, 2048)
    // 128 ms at 48 kHz in AudioWorklet-sized pieces of 2048 frames.
    const frames: Float32Array[] = []
    for (let i = 0; i < 3; i++) frames.push(...down(new Float32Array(2048).fill(0.5)))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.length).toBe(2048)
    expect(frames[0]!.every(sample => Math.abs(sample - 0.5) < 1e-6)).toBe(true)
  })

  it('takes a rate that is not a multiple of 16 kHz, and loses no time doing it', () => {
    const down = createDownsampler(44100, 16000, 160)
    let out = 0
    for (let i = 0; i < 100; i++) out += down(new Float32Array(441)).length * 160
    expect(Math.abs(out - 16000)).toBeLessThanOrEqual(160)
  })

  it('averages a tone above what 16 kHz can carry down to nearly nothing', () => {
    const down = createDownsampler(48000, 16000, 1600)
    const input = new Float32Array(4800)
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(2 * Math.PI * 16000 * i / 48000)
    const [frame] = down(input)
    expect(Math.max(...frame!.map(Math.abs))).toBeLessThan(0.01)
  })
})
