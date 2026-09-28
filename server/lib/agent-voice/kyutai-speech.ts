import { decode, encode } from '@msgpack/msgpack'
import WebSocket from 'ws'
import { base64FromPcm16, resamplePcm16 } from '../voice/audio'
import type { SpeechChunk } from './speech'

/**
 * Kyutai's moshi-server, the one Unmute runs on: streaming transcription at
 * `/api/asr-streaming` and streaming speech at `/api/tts_streaming`, both
 * msgpack over a WebSocket at 24 kHz float PCM. The protocol is what the
 * reference scripts in kyutai-labs/delayed-streams-modeling do.
 *
 * **Written from the reference clients, not measured against a server.** A
 * moshi-server needs a GPU, and none was reachable when this was built. The
 * shapes are the scripts' exactly, so the first run against a real server is
 * the test.
 *
 * Transcription here is turn-at-a-time, like the other engines: the turn's
 * audio is streamed in, then enough silence for the model's delay to run
 * out, then a marker whose echo means every word is in. The model's own
 * semantic end-of-turn heads (`Step.prs`) are not used yet; Smart Turn still
 * decides when a turn is over.
 */

const RATE = 24000
/** The largest of the model's delays, so the last word has time to appear. */
const FLUSH_SECONDS = 3
/** The semantic VAD's heads predict pauses of 0.5, 1, 2 and 3 seconds; Unmute uses the third. */
const PAUSE_HEAD = 2
const PAUSE_HEAD_SECONDS = 2

function apiKey(): string {
  return process.env.NUXT_KYUTAI_API_KEY || 'public_token'
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { 'kyutai-api-key': apiKey() } })
    socket.binaryType = 'nodebuffer'
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function floats(samples: Int16Array): number[] {
  const out = new Array<number>(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / 32768
  return out
}

export async function transcribeKyutai(
  samples: Int16Array,
  sampleRate: number,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string> {
  const socket = await open(`${baseUrl.replace(/\/$/, '')}/api/asr-streaming`)
  const words: string[] = []
  const markerId = Date.now() % 100000
  return new Promise<string>((resolve, reject) => {
    const finish = () => {
      socket.close()
      resolve(words.join(' ').replace(/\s+/g, ' ').trim())
    }
    signal?.addEventListener('abort', () => {
      socket.close()
      reject(new Error('aborted'))
    })
    socket.on('message', (raw) => {
      const message = decode(raw as Buffer) as any
      if (message?.type === 'Word' && typeof message.text === 'string') words.push(message.text)
      else if (message?.type === 'Marker' && message.id === markerId) finish()
      else if (message?.type === 'Error') reject(new Error(String(message.message ?? 'server error')))
    })
    socket.on('close', finish)
    socket.on('error', reject)

    const audio = resamplePcm16(samples, sampleRate, RATE)
    const frame = 1920
    for (let i = 0; i < audio.length; i += frame) {
      socket.send(encode({ type: 'Audio', pcm: floats(audio.subarray(i, i + frame)) }))
    }
    const silence = new Array<number>(frame).fill(0)
    for (let i = 0; i < (FLUSH_SECONDS * RATE) / frame; i++) socket.send(encode({ type: 'Audio', pcm: silence }))
    socket.send(encode({ type: 'Marker', id: markerId }))
  })
}

/**
 * The transcriber's own answer to "is the turn over?": the pause head of its
 * semantic VAD, read off the `Step` messages after the turn's audio has gone
 * in and enough silence has followed for the head to see the pause. Unmute
 * reads head 2, the two-second one, and so does this. Untested against a
 * server, like the rest of this file.
 */
export async function endOfTurnKyutai(
  samples: Int16Array,
  sampleRate: number,
  baseUrl: string
): Promise<number | null> {
  const socket = await open(`${baseUrl.replace(/\/$/, '')}/api/asr-streaming`)
  const markerId = Date.now() % 100000
  return new Promise<number | null>((resolve, reject) => {
    let last: number | null = null
    const finish = () => {
      socket.close()
      resolve(last)
    }
    socket.on('message', (raw) => {
      const message = decode(raw as Buffer) as any
      if (message?.type === 'Step' && Array.isArray(message.prs)) last = Number(message.prs[PAUSE_HEAD] ?? last)
      else if (message?.type === 'Marker' && message.id === markerId) finish()
    })
    socket.on('close', finish)
    socket.on('error', reject)
    const audio = resamplePcm16(samples, sampleRate, RATE)
    const frame = 1920
    for (let i = 0; i < audio.length; i += frame) {
      socket.send(encode({ type: 'Audio', pcm: floats(audio.subarray(i, i + frame)) }))
    }
    const silence = new Array<number>(frame).fill(0)
    for (let i = 0; i < (PAUSE_HEAD_SECONDS * RATE) / frame; i++) socket.send(encode({ type: 'Audio', pcm: silence }))
    socket.send(encode({ type: 'Marker', id: markerId }))
  })
}

export async function synthesizeKyutai(
  text: string,
  baseUrl: string,
  voice: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const query = new URLSearchParams({ voice, format: 'PcmMessagePack' })
  const socket = await open(`${baseUrl.replace(/\/$/, '')}/api/tts_streaming?${query}`)
  await new Promise<void>((resolve, reject) => {
    signal?.addEventListener('abort', () => {
      socket.close()
      resolve()
    })
    socket.on('message', (raw) => {
      const message = decode(raw as Buffer) as any
      if (message?.type !== 'Audio' || !Array.isArray(message.pcm)) return
      const pcm = new Int16Array(message.pcm.length)
      for (let i = 0; i < pcm.length; i++) {
        const clamped = Math.max(-1, Math.min(1, Number(message.pcm[i])))
        pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
      }
      onChunk({ data: base64FromPcm16(pcm), sampleRate: RATE })
    })
    socket.on('close', () => resolve())
    socket.on('error', reject)
    socket.send(encode({ type: 'Text', text }))
    socket.send(encode({ type: 'Eos' }))
  })
}
