import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BroadcastChannel } from 'node:worker_threads'
import { dataDir } from '../paths'
import {
  LOCAL_MODELS_CHANNEL,
  LOCAL_MODELS_HOST_ENV,
  LOCAL_MODELS_WORKER_FILE,
  createLocalModelsHost,
  sourceWorkerEntry,
  type FromWorker,
  type LocalModelRequest,
  type ToWorker,
  type WorkerEntry
} from './local-models-host'

/**
 * The server's side of the local models' process (`local-models-host.ts`):
 * a request goes out, an answer or an error comes back, and Kokoro's audio
 * comes back piece by piece before its answer.
 *
 * Under `pnpm dev` the dev process's main thread holds the process, and this
 * talks to it over a `BroadcastChannel`, because the Nitro worker thread this
 * runs in is replaced on every reload. Anywhere else, this holds it.
 */

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onAudio?: (pcm: Int16Array, sampleRate: number) => void
}

interface Link {
  post: (message: ToWorker) => void
  /** Stops the worker if this link holds it; a dev link only lets go of the channel. */
  close: () => void
}

const pending = new Map<string, Pending>()
let link: Link | null = null

function receive(message: FromWorker) {
  const waiting = pending.get(message.id)
  if (!waiting) return
  if (message.kind === 'audio') {
    waiting.onAudio?.(message.pcm, message.sampleRate)
    return
  }
  pending.delete(message.id)
  if (message.kind === 'result') waiting.resolve(message.value)
  else waiting.reject(new Error(message.message))
}

/**
 * The worker's entry. In a build, Nitro writes it next to the server bundle
 * (`modules/local-models.ts`), and Nitro points `import.meta.url` at the
 * bundle wherever this code ends up. Run from source, as `scripts/stt-bench`
 * does, it is the TypeScript beside this file.
 */
function workerEntry(): WorkerEntry {
  const modelsDir = join(dataDir(), 'models')
  if (import.meta.url.endsWith('.ts')) return sourceWorkerEntry(modelsDir)
  return { path: fileURLToPath(new URL(`./${LOCAL_MODELS_WORKER_FILE}`, import.meta.url)), execArgv: [], modelsDir }
}

function connect(): Link {
  if (process.env[LOCAL_MODELS_HOST_ENV] === String(process.pid)) {
    const channel = new BroadcastChannel(LOCAL_MODELS_CHANNEL)
    channel.unref()
    channel.onmessage = event => receive(event.data as FromWorker)
    return {
      post: message => channel.postMessage(message),
      close: () => channel.close()
    }
  }
  const host = createLocalModelsHost(workerEntry)
  host.listen(receive)
  return {
    post: message => host.post(message),
    close: () => host.stop()
  }
}

/**
 * Ask the local models' process. It is started on the first request, and
 * again on the next one if it died; a death fails what it had not answered.
 */
export function requestLocalModel<T>(
  request: LocalModelRequest,
  options: { signal?: AbortSignal, onAudio?: Pending['onAudio'] } = {}
): Promise<T> {
  link ??= connect()
  const id = randomUUID()
  const { signal, onAudio } = options
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!pending.delete(id)) return
      link?.post({ kind: 'abort', id })
      resolve(undefined as T)
    }
    pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value as T)
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
      onAudio
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    link!.post({ kind: 'request', id, request })
  })
}

/**
 * For the server's `close` hook. Under `pnpm dev` that hook runs on every
 * reload too, and there the worker belongs to the dev process's main thread,
 * so this only stops a worker this server holds itself: one that is really
 * exiting. However the server goes, the worker goes with it anyway, because
 * its IPC channel closes.
 */
export function stopLocalModels() {
  link?.close()
  link = null
  for (const [id, waiting] of pending) {
    pending.delete(id)
    waiting.reject(new Error('the server is stopping'))
  }
}
