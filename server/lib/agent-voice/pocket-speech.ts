import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { clonedVoiceId } from '../../../shared/agent-voice'
import { dataDir } from '../paths'
import type { SpeechChunk } from './speech'
import { clonedVoiceSamplePath, isClonedVoiceId } from './voice-store'

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
 *
 * A cloned voice goes to Pocket as a URL rather than an upload, because
 * Pocket keeps the state it computes from a sample per URL: an upload is
 * encoded again on every request (first audio 2.2 s here, every time), a
 * URL once (2.2 s, then 0.18 s, as fast as a built-in voice). The URL is a
 * server of Domo's own on the loopback, so the samples are never on the
 * app's public port. A Pocket server elsewhere cannot reach it, and gets
 * the upload.
 */

const POCKET_VERSION = '3.3.0'
/** The first start fetches Python packages and the model; later ones take seconds. */
const START_TIMEOUT_MS = 10 * 60_000

/** How Pocket fails a request for a clone when it has only the weights without cloning. */
export const CLONING_UNAVAILABLE = 'Pocket TTS has no voice-cloning weights, so it cannot speak with a cloned voice. '
  + 'Accept Kyutai\'s terms on huggingface.co/kyutai/pocket-tts, set HF_TOKEN to a token of that account '
  + 'in Domo\'s environment, and restart Domo.'

interface PocketLog {
  /** Characters written so far, to find what a request added. */
  written: () => number
  /** What was written after `mark`, as far as the tail still holds it. */
  since: (mark: number) => string
}

let server: { url: string, process: ChildProcess | null, log: PocketLog } | null = null
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

/**
 * Where the process group of Domo's own Pocket server is written down.
 *
 * Nothing kills a child when its parent is stopped, and `uvx` starts Python
 * as a child of its own, so each Domo restart left a Pocket server running,
 * a few hundred MB each. Pocket runs in a process group of its own, and the
 * next start stops whatever group the last one left.
 */
function pidFile(): string {
  return join(dataDir(), 'pocket-tts.pid')
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

function stopLeftover() {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8'))
    if (Number.isInteger(pid) && pid > 1) killGroup(pid)
  } catch {
    /* none left */
  }
  rmSync(pidFile(), { force: true })
}

async function startServer(): Promise<string> {
  stopLeftover()
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  console.log(`[agent-voice] starting Pocket TTS ${POCKET_VERSION} on ${url} (the first start downloads it)`)
  const child = spawn('uvx', ['--from', `pocket-tts==${POCKET_VERSION}`, 'pocket-tts', 'serve', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, HF_HOME: process.env.HF_HOME ?? join(dataDir(), 'models', 'hf') },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true
  })
  if (child.pid) writeFileSync(pidFile(), String(child.pid))
  let failure: string | null = null
  child.on('error', (error: any) => {
    failure = error?.code === 'ENOENT'
      ? 'Pocket TTS needs uv (brew install uv, or see docs.astral.sh/uv), or a Pocket TTS server URL in Settings.'
      : String(error?.message ?? error)
  })
  // Kept after the start too: Pocket answers a failed request with a bare
  // 500, and the reason is only in its log.
  let tail = ''
  let written = 0
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    written += text.length
    tail = `${tail}${text}`.slice(-4000)
  })
  const log: PocketLog = {
    written: () => written,
    since: mark => tail.slice(Math.max(0, tail.length - (written - mark)))
  }
  child.on('exit', (code) => {
    if (server?.process === child) server = null
    if (!failure) failure = `Pocket TTS stopped (${code}): ${tail.trim().split('\n').pop() ?? ''}`
  })
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (failure) throw new Error(failure)
    if (await reachable(url)) {
      server = { url, process: child, log }
      console.log('[agent-voice] Pocket TTS is up')
      return url
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (child.pid) killGroup(child.pid)
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

let samples: Promise<string> | null = null

/** The loopback server Pocket fetches cloned voices' samples from, started once. */
function sampleServer(): Promise<string> {
  if (!samples) {
    samples = new Promise<string>((resolve, reject) => {
      const http = createHttpServer((request, response) => {
        const id = /^\/([a-z0-9]+)\.wav$/.exec(request.url ?? '')?.[1]
        const path = id && isClonedVoiceId(id) ? clonedVoiceSamplePath(id) : null
        if (request.method !== 'GET' || !path || !existsSync(path)) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': 'audio/wav' })
        createReadStream(path).pipe(response)
      })
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => {
        const address = http.address()
        if (typeof address === 'object' && address) resolve(`http://127.0.0.1:${address.port}`)
        else reject(new Error('no port for the voice samples'))
      })
      // Never the reason the process stays up.
      http.unref()
    }).catch((error) => {
      samples = null
      throw error
    })
  }
  return samples
}

function onLoopback(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * The request's voice: a built-in name as it is, a clone as a URL of its
 * sample on this machine's loopback, or as the sample itself for a Pocket
 * server that cannot reach the loopback.
 */
export async function appendPocketVoice(form: FormData, voice: string, url: string): Promise<void> {
  const id = clonedVoiceId(voice)
  if (id === null) {
    form.append('voice_url', voice || 'alba')
    return
  }
  const path = clonedVoiceSamplePath(id)
  if (!path || !existsSync(path)) throw new Error('The cloned voice chosen in Settings no longer exists. Choose another voice.')
  if (onLoopback(url)) {
    form.append('voice_url', `${await sampleServer()}/${id}.wav`)
  } else {
    form.append('voice_wav', new Blob([await readFile(path)], { type: 'audio/wav' }), `${id}.wav`)
  }
}

const NO_CLONING = /weights for the model with voice cloning/

/**
 * Why a request failed, in words that say what to do when it was the
 * cloning weights. `mark` is where Pocket's log stood when the request went
 * out, or null for a server Domo does not run, which cannot be asked why.
 */
async function failure(response: Response, cloned: boolean, mark: number | null): Promise<Error> {
  const body = (await response.text().catch(() => '')).slice(0, 200)
  if (cloned && response.status >= 500) {
    if (mark === null) {
      return new Error(`Pocket TTS could not use the cloned voice (${response.status}). If that server has no voice-cloning weights, `
        + 'accept Kyutai\'s terms on huggingface.co/kyutai/pocket-tts and give it HF_TOKEN.')
    }
    // The traceback reaches the log just after the 500 goes out.
    const log = server?.log
    for (let wait = 0; log && wait < 20 && !NO_CLONING.test(log.since(mark)); wait++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (log && NO_CLONING.test(log.since(mark))) return new Error(CLONING_UNAVAILABLE)
  }
  return new Error(`Pocket TTS: ${response.status} ${body}`)
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
  await appendPocketVoice(form, voice, url)
  const mark = configuredUrl.trim() ? null : server?.log.written() ?? null
  const response = await fetch(`${url}/tts`, { method: 'POST', body: form, signal })
  if (!response.ok || !response.body) throw await failure(response, clonedVoiceId(voice) !== null, mark)
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
  if (server?.process?.pid) killGroup(server.process.pid)
  rmSync(pidFile(), { force: true })
  server = null
}
