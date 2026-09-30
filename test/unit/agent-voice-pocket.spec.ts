import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesizePocket } from '../../server/lib/agent-voice/pocket-speech'
import { createClonedVoice } from '../../server/lib/agent-voice/voice-store'
import { sampleWav } from './wav-fixture'

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

const realFetch = globalThis.fetch
let dataDir: string | null = null
afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.NUXT_DATA_DIR
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  dataDir = null
})

async function clonedVoice() {
  dataDir = mkdtempSync(join(tmpdir(), 'domo-pocket-'))
  process.env.NUXT_DATA_DIR = dataDir
  const voice = await createClonedVoice('Mine', sampleWav(6))
  return { voice, sample: readFileSync(join(dataDir, 'voices', `${voice.id}.wav`)) }
}

function answering(status: number, body: BodyInit | null, forms: FormData[]) {
  return vi.fn(async (_url: string, init: any) => {
    forms.push(init.body)
    return new Response(body, { status })
  })
}

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

  it('asks a Pocket on the loopback for a clone by a URL it can fetch the sample from', async () => {
    const { voice, sample } = await clonedVoice()
    const forms: FormData[] = []
    vi.stubGlobal('fetch', answering(200, Buffer.from(wav(new Int16Array(4), 24000)), forms))
    await synthesizePocket('Hi.', `clone:${voice.id}`, 'http://127.0.0.1:8000', () => {})
    const url = forms[0]!.get('voice_url') as string
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/${voice.id}\\.wav$`))
    expect(forms[0]!.get('voice_wav')).toBeNull()
    // What Pocket will download is the sample itself, and nothing else is served.
    const served = await realFetch(url)
    expect(served.headers.get('content-type')).toBe('audio/wav')
    expect(Buffer.from(await served.arrayBuffer()).equals(sample)).toBe(true)
    expect((await realFetch(url.replace(voice.id, 'aaaaaaaaaaaa'))).status).toBe(404)
    expect((await realFetch(url.replace(`${voice.id}.wav`, '..%2F..%2Fsettings.json'))).status).toBe(404)
  })

  it('uploads the sample to a Pocket elsewhere, which cannot reach the loopback', async () => {
    const { voice, sample } = await clonedVoice()
    const forms: FormData[] = []
    vi.stubGlobal('fetch', answering(200, Buffer.from(wav(new Int16Array(4), 24000)), forms))
    await synthesizePocket('Hi.', `clone:${voice.id}`, 'http://pocket.lan:8000', () => {})
    expect(forms[0]!.get('voice_url')).toBeNull()
    const upload = forms[0]!.get('voice_wav') as File
    expect(Buffer.from(await upload.arrayBuffer()).equals(sample)).toBe(true)
  })

  it('says what to do when a clone fails, and when it is gone', async () => {
    const { voice } = await clonedVoice()
    vi.stubGlobal('fetch', answering(500, 'Internal Server Error', []))
    await expect(synthesizePocket('Hi.', `clone:${voice.id}`, 'http://pocket.lan:8000', () => {}))
      .rejects.toThrow(/accept Kyutai's terms on huggingface\.co\/kyutai\/pocket-tts and give it HF_TOKEN/)
    // A built-in voice failing is not about cloning.
    await expect(synthesizePocket('Hi.', 'alba', 'http://pocket.lan:8000', () => {})).rejects.toThrow(/^Pocket TTS: 500/)
    await expect(synthesizePocket('Hi.', 'clone:aaaaaaaaaaaa', 'http://pocket.lan:8000', () => {})).rejects.toThrow(/no longer exists/)
  })
})
