import { describe, expect, it } from 'vitest'

import { base64FromPcm16, pcm16FromBase64, resamplePcm16 } from '../../server/lib/agent-voice/pcm'

/**
 * Arithmetic on the PCM the voice bar carries: that the right number of
 * samples comes out, that the ends are not invented, and that a chunk
 * survives the round trip through base64 unchanged.
 */

function ramp(length: number): Int16Array {
  const samples = new Int16Array(length)
  for (let i = 0; i < length; i++) samples[i] = i * 100
  return samples
}

describe('PCM16 base64', () => {
  it('round-trips a chunk unchanged', () => {
    const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234])

    expect([...pcm16FromBase64(base64FromPcm16(samples))]).toEqual([...samples])
  })

  it('drops a stray odd byte rather than shifting every sample after it', () => {
    const whole = base64FromPcm16(Int16Array.from([1, 2, 3]))
    const odd = Buffer.concat([Buffer.from(whole, 'base64'), Buffer.from([0x7f])]).toString('base64')

    expect([...pcm16FromBase64(odd)]).toEqual([1, 2, 3])
  })
})

describe('resampling', () => {
  it('returns the same array when the rates match', () => {
    const samples = ramp(8)

    expect(resamplePcm16(samples, 16000, 16000)).toBe(samples)
  })

  it('produces three samples for every two at 16 kHz to 24 kHz', () => {
    expect(resamplePcm16(ramp(1024), 16000, 24000)).toHaveLength(1536)
    expect(resamplePcm16(ramp(2048), 16000, 24000)).toHaveLength(3072)
  })

  it('interpolates between the samples it was given', () => {
    // Each output sample sits two thirds of a source step further along than
    // the one before it, so a straight ramp in stays a straight ramp out —
    // except the last, which has nothing after it to interpolate toward and
    // holds instead (see the chunk-boundary test below).
    const out = resamplePcm16(Int16Array.from([0, 300, 600, 900]), 16000, 24000)

    expect([...out]).toEqual([0, 200, 400, 600, 800, 900])
  })

  it('holds the last sample rather than interpolating toward zero at the end', () => {
    // A chunk boundary must not produce a click. The final output sample sits
    // past the last input one, and repeating it is silent where a decay to
    // zero would not be.
    const out = resamplePcm16(Int16Array.from([1000, 1000, 1000]), 16000, 24000)

    expect([...out]).toEqual([1000, 1000, 1000, 1000])
  })

  it('never returns an empty chunk for a chunk that had audio in it', () => {
    expect(resamplePcm16(Int16Array.from([5]), 16000, 24000)).toHaveLength(1)
    expect(resamplePcm16(new Int16Array(0), 16000, 24000)).toHaveLength(0)
  })

  it('downsamples as well, so the ratio is not assumed to be an upward one', () => {
    expect(resamplePcm16(ramp(2400), 24000, 16000)).toHaveLength(1600)
  })
})
