import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * with WAV streamed as it is made. Cloning a voice from a sample needs the
 * weights Kyutai gates behind its terms; Domo's own model config
 * (`POCKET_CONFIG`) fetches them from a mirror on Domo's GitHub releases (CC
 * BY 4.0, attributed there), so nobody needs a Hugging Face account. If that
 * download fails Pocket falls back to the open weights, and only the built-in
 * voices work.
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
export const CLONING_UNAVAILABLE = 'Pocket TTS could not fetch the voice-cloning weights from github.com when it started, '
  + 'so it cannot speak with a cloned voice. Check the connection and restart Domo.'

/** Kyutai's English weights with voice cloning, mirrored (see the release page for the licence and terms). */
const CLONING_WEIGHTS_URL = 'https://github.com/andresberrios/domo/releases/download/pocket-tts-weights-2026-09/english-model.safetensors'

/**
 * Pocket's own `english.yaml` for this version, with the cloning weights
 * taken from the mirror instead of the gated Hugging Face repository; the
 * open weights and the tokenizer stay where Pocket keeps them. Tied to
 * `POCKET_VERSION`: a new Pocket may change the architecture below.
 */
const POCKET_CONFIG = `weights_path: ${CLONING_WEIGHTS_URL}
weights_path_without_voice_cloning: hf://kyutai/pocket-tts-without-voice-cloning/languages/english/model.safetensors@e7205b6ee50e654a5ea19f0e9df2b0813b05e921
default_temperature: 0.3

flow_lm:
  insert_bos_before_voice: true
  dtype: float32
  flow:
    depth: 6
    dim: 512
  transformer:
    d_model: 1024
    hidden_scale: 4
    max_period: 10000
    num_heads: 16
    num_layers: 6
  lookup_table:
    dim: 1024
    n_bins: 4000
    tokenizer: tokenizers
    tokenizer_path: hf://kyutai/pocket-tts-without-voice-cloning/languages/english/tokenizer.json@00eac05ed3d16bdc3f6b5d598874019c34a89214

mimi:
  dtype: float32
  sample_rate: 24000
  inner_dim: 32
  outer_dim: 512
  channels: 1
  frame_rate: 12.5
  seanet:
    dimension: 512
    channels: 1
    n_filters: 64
    n_residual_layers: 1
    ratios:
    - 6
    - 5
    - 4
    kernel_size: 7
    residual_kernel_size: 3
    last_kernel_size: 3
    dilation_base: 2
    pad_mode: constant
    compress: 2
  transformer:
    d_model: 512
    num_heads: 8
    num_layers: 2
    layer_scale: 0.01
    context: 250
    dim_feedforward: 2048
    input_dimension: 512
    output_dimensions:
    - 512
  quantizer:
    dimension: 32
    output_dimension: 512
`

/** The config file Pocket is started with, written fresh each start so an upgrade never reads an old one. */
function pocketConfigPath(): string {
  const dir = join(dataDir(), 'models')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `pocket-tts-${POCKET_VERSION}.yaml`)
  writeFileSync(path, POCKET_CONFIG)
  return path
}

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
 * a few hundred MB each. Pocket runs in a process group of its own, which a
 * watchdog stops when Domo goes (see `startServer`), the `close` hook in
 * `server/plugins/boot.ts` stops on a clean shutdown, and the next start stops
 * if both somehow missed it.
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
  // A watchdog in front of the server: it reads a pipe from Domo, which the
  // system closes however Domo stops (a close, Ctrl+C, a crash, kill -9), and
  // then stops the whole process group. The server itself reads nothing, so
  // it could not tell. fd 3 carries the pipe past the backgrounded reader,
  // whose own stdin a non-interactive shell points at /dev/null.
  const watchdog = 'exec 3<&0; (cat <&3 >/dev/null; kill -TERM 0) & exec "$@" </dev/null 3<&-'
  const child = spawn('sh', ['-c', watchdog, 'pocket', 'uvx', '--from', `pocket-tts==${POCKET_VERSION}`, 'pocket-tts', 'serve', '--host', '127.0.0.1', '--port', String(port), '--config', pocketConfigPath()], {
    env: { ...process.env, HF_HOME: process.env.HF_HOME ?? join(dataDir(), 'models', 'hf') },
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: true
  })
  if (child.pid) writeFileSync(pidFile(), String(child.pid))
  const needsUv = 'Pocket TTS needs uv (brew install uv, or see docs.astral.sh/uv), or a Pocket TTS server URL in Settings.'
  let failure: string | null = null
  child.on('error', (error: any) => {
    failure = String(error?.message ?? error)
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
    // 127 is the shell's "command not found": no uvx on the PATH.
    if (!failure) failure = code === 127 ? needsUv : `Pocket TTS stopped (${code}): ${tail.trim().split('\n').pop() ?? ''}`
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

/** Start Domo's own server ahead of the first request, which downloads it and the model. */
export function warmPocket(configured: string): Promise<string> {
  return pocketServer(configured)
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
/**
 * A built-in voice as the state Pocket precomputed for it, by path. A bare
 * name resolves only under Pocket's own language configs, and Domo starts
 * Pocket on a config of its own (`POCKET_CONFIG`); the path and revision are
 * the ones Pocket 3.3.0 resolves a name to, in the open repository.
 */
export function builtInVoiceUrl(name: string): string {
  return `hf://kyutai/pocket-tts-without-voice-cloning/languages/english/embeddings/${name}.safetensors@4e1e0a3e611c51c0b4ed8174fc10f32a54644303`
}

export async function appendPocketVoice(form: FormData, voice: string, url: string): Promise<void> {
  const id = clonedVoiceId(voice)
  if (id === null) {
    form.append('voice_url', builtInVoiceUrl(voice || 'alba'))
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
        + 'leave the server field empty and let Domo run its own.')
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
