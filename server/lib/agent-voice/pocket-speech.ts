import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { dataDir } from '../paths'
import type { SpeechChunk } from './speech'

/**
 * Kyutai's Pocket TTS (MIT): a 100M-parameter voice model made for the CPU.
 * Measured here against Kokoro on the same answer: first audio in about
 * 0.2 s against 3.3 s, and more natural on UTMOS (4.45 for `alba` against
 * Kokoro's 4.28, level with Gemini's full speech model at 4.46).
 *
 * It is Python, so Domo runs it as its own server, `pocket-tts serve`,
 * started through `uvx` on first use and kept running, which holds the model
 * in memory; or it talks to one already running at `pocketUrl`. The server
 * answers `POST /tts` (form: `text`, and `voice_url` for a built-in voice)
 * with WAV streamed as it is made. Cloning a voice from a sample needs
 * Kyutai's gated weights (a Hugging Face token that has accepted their
 * terms, `HF_TOKEN`); without them only the built-in voices work.
 */

const POCKET_VERSION = '3.3.0'
/** The first start fetches Python packages and the model; later ones take seconds. */
const START_TIMEOUT_MS = 10 * 60_000

let server: { url: string, process: ChildProcess | null } | null = null
let starting: Promise<string> | null = null

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return response.ok
  } catch {
    return false
  }
}

async function startServer(): Promise<string> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  console.log(`[agent-voice] starting Pocket TTS ${POCKET_VERSION} on ${url} (the first start downloads it)`)
  const child = spawn('uvx', ['--from', `pocket-tts==${POCKET_VERSION}`, 'pocket-tts', 'serve', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, HF_HOME: process.env.HF_HOME ?? join(dataDir(), 'models', 'hf') },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  let failure: string | null = null
  child.on('error', (error: any) => {
    failure = error?.code === 'ENOENT'
      ? 'Pocket TTS needs uv (brew install uv, or see docs.astral.sh/uv), or a Pocket TTS server URL in Settings.'
      : String(error?.message ?? error)
  })
  let tail = ''
  child.stderr?.on('data', (chunk) => { tail = `${tail}${chunk}`.slice(-2000) })
  child.on('exit', (code) => {
    if (server?.process === child) server = null
    if (!failure) failure = `Pocket TTS stopped (${code}): ${tail.trim().split('\n').pop() ?? ''}`
  })
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (failure) throw new Error(failure)
    if (await reachable(url)) {
      server = { url, process: child }
      console.log('[agent-voice] Pocket TTS is up')
      return url
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  child.kill()
  throw new Error('Pocket TTS did not start within ten minutes')
}

/** The server to speak through: the one in Settings, or Domo's own, started once. */
async function pocketServer(configured: string): Promise<string> {
  if (configured.trim()) return configured.trim().replace(/\/$/, '')
  if (server) return server.url
  if (!starting) {
    starting = startServer().finally(() => { starting = null })
  }
  return starting
}

/** Speak `text`, handing on the PCM as the server streams it. */
export async function synthesizePocket(
  text: string,
  voice: string,
  configuredUrl: string,
  onChunk: (chunk: SpeechChunk) => void,
  signal?: AbortSignal
): Promise<void> {
  const url = await pocketServer(configuredUrl)
  const form = new FormData()
  form.append('text', text)
  form.append('voice_url', voice || 'alba')
  const response = await fetch(`${url}/tts`, { method: 'POST', body: form, signal })
  if (!response.ok || !response.body) throw new Error(`Pocket TTS: ${response.status} ${(await response.text()).slice(0, 200)}`)
  const reader = response.body.getReader()
  // A WAV header first, then PCM16: the rate is read from the header, and
  // a chunk may split a sample, whose odd byte waits for the next one.
  let header = new Uint8Array(0)
  let rate = 24000
  let carry: Uint8Array | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (signal?.aborted) {
      await reader.cancel().catch(() => {})
      return
    }
    let bytes: Uint8Array = value
    if (header.length < 44) {
      const joined = new Uint8Array(header.length + bytes.length)
      joined.set(header)
      joined.set(bytes, header.length)
      if (joined.length < 44) {
        header = joined
        continue
      }
      const view = Buffer.from(joined.buffer, joined.byteOffset, joined.length)
      rate = view.readUInt32LE(24)
      const data = view.indexOf('data', 12, 'ascii')
      const start = data >= 0 ? data + 8 : 44
      header = joined.subarray(0, start)
      bytes = joined.subarray(start)
    }
    if (carry) {
      const joined = new Uint8Array(carry.length + bytes.length)
      joined.set(carry)
      joined.set(bytes, carry.length)
      bytes = joined
      carry = null
    }
    if (bytes.length % 2) {
      carry = bytes.subarray(bytes.length - 1)
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    if (bytes.length) onChunk({ data: Buffer.from(bytes).toString('base64'), sampleRate: rate })
  }
}

/** Stop the server Domo started, if it did. */
export function stopPocket() {
  server?.process?.kill()
  server = null
}
