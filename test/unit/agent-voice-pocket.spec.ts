import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesizePocket } from '../../server/lib/agent-voice/pocket-speech'

/**
 * Pocket TTS answers with a WAV streamed as it is made. The parser has to
 * find the rate in a header that may arrive in pieces, and keep a sample
 * that a chunk boundary splits in two.
 */
function wav(samples: Int16Array, rate: number): Uint8Array {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.write('data', 36)
  return new Uint8Array(Buffer.concat([header, Buffer.from(samples.buffer)]))
}

afterEach(() => vi.unstubAllGlobals())

describe('synthesizePocket', () => {
  it('streams the PCM whatever the chunk boundaries, at the header\'s rate', async () => {
    const samples = Int16Array.from({ length: 101 }, (_, i) => i * 300 - 15000)
    const bytes = wav(samples, 24000)
    // Split mid-header and at odd offsets inside the samples.
    const pieces = [bytes.subarray(0, 20), bytes.subarray(20, 51), bytes.subarray(51, 120), bytes.subarray(120)]
    const form: FormData[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      form.push(init.body)
      return new Response(new ReadableStream({
        start(controller) {
          for (const piece of pieces) controller.enqueue(piece)
          controller.close()
        }
      }))
    }))
    const out: number[] = []
    let rate = 0
    await synthesizePocket('Hello there.', 'mary', 'http://pocket.test', (chunk) => {
      rate = chunk.sampleRate
      const pcm = Buffer.from(chunk.data, 'base64')
      for (let i = 0; i < pcm.length; i += 2) out.push(pcm.readInt16LE(i))
    })
    expect(rate).toBe(24000)
    expect(out).toEqual(Array.from(samples))
    expect(form[0]!.get('voice_url')).toBe('mary')
    expect(form[0]!.get('text')).toBe('Hello there.')
  })
})
