import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The process the open speech models run in, and the messages it takes.
 *
 * `onnxruntime-node` is a native addon, and a native addon loads once per
 * process. Under `pnpm dev`, Nitro reloads into a new worker thread of the
 * same process on every `server/` edit, and every model then failed with
 * "Module did not self-register" until the whole dev server restarted. So
 * the models live in a child process of their own (`local-models-worker.ts`),
 * held by whoever outlives a reload: the dev process's main thread under
 * `pnpm dev` (`modules/local-models.ts`), the server itself in a build
 * (`local-models.ts`).
 *
 * The child stops when its holder does, however that stops: it exits when
 * its IPC channel closes, which the system does when the holder dies, a
 * kill -9 included.
 */

/** The worker entry's file name in a build, next to the server bundle. */
export const LOCAL_MODELS_WORKER_FILE = 'local-models-worker.mjs'

/**
 * Set by the dev process's main thread to its own pid, which is how a Nitro
 * worker thread knows the main thread holds the models and listens on a
 * `BroadcastChannel` of this name. A pid, so that a server started by
 * something Domo ran, which inherits the variable, does not wait on a
 * channel nobody listens to.
 */
export const LOCAL_MODELS_HOST_ENV = 'DOMO_LOCAL_MODELS_HOST'
export const LOCAL_MODELS_CHANNEL = 'domo:local-models'

export type LocalModelRequest =
  /** Loads a transcriber, and says whether it is Whisper (which takes a prompt and hears 30 s at a time). */
  | { op: 'transcriber', model: string }
  | { op: 'transcribe', model: string, audio: Float32Array, prompt: string, language: string }
  /** Kokoro's own sentence splitter. */
  | { op: 'sentences', text: string }
  /** Kokoro, answered with `audio` messages piece by piece, then a result. */
  | { op: 'speak', pieces: string[], voice: string, styleTokens: number | null, pauseSeconds: number }
  /** Smart Turn's p(complete) for 16 kHz PCM16, or `null` when the model cannot be had. */
  | { op: 'turn', samples: Int16Array }

export type ToWorker =
  | { kind: 'request', id: string, request: LocalModelRequest }
  | { kind: 'abort', id: string }

export type FromWorker =
  | { kind: 'result', id: string, value: unknown }
  | { kind: 'error', id: string, message: string }
  | { kind: 'audio', id: string, pcm: Int16Array, sampleRate: number }

export interface WorkerEntry {
  path: string
  /** Node flags for the child: a TypeScript loader when it runs from source. */
  execArgv: string[]
  /** Where the weights are kept, `<data>/models`: the worker's one argument. */
  modelsDir: string
}

/**
 * The worker run from its TypeScript, through jiti, which comes with Nuxt:
 * for the dev server, whose bundle has no room for a second entry (Nitro
 * inlines everything into one file in dev), and for scripts run from
 * source. Only valid where this file is itself run from source.
 */
export function sourceWorkerEntry(modelsDir: string): WorkerEntry {
  const nuxt = createRequire(import.meta.url).resolve('nuxt/package.json')
  // `jiti/register` is import-only, so require finds the package instead.
  const jiti = createRequire(nuxt).resolve('jiti/package.json')
  return {
    path: fileURLToPath(new URL('./local-models-worker.ts', import.meta.url)),
    execArgv: ['--import', pathToFileURL(join(dirname(jiti), 'lib', 'jiti-register.mjs')).href],
    modelsDir
  }
}

export interface LocalModelsHost {
  post: (message: ToWorker) => void
  listen: (listener: (message: FromWorker) => void) => void
  stop: () => void
}

interface Child {
  process: ChildProcess
  /** What it was asked and has not answered. */
  pending: Set<string>
  code: Code
}

/** Starts the worker on the first message, and again on the next one after it died. */
export function createLocalModelsHost(entry: () => WorkerEntry): LocalModelsHost {
  const listeners = new Set<(message: FromWorker) => void>()
  const emit = (message: FromWorker) => {
    for (const listener of listeners) listener(message)
  }
  let child: Child | null = null

  function start(): Child {
    const { path, execArgv, modelsDir } = entry()
    const worker = fork(path, [modelsDir], {
      execArgv,
      // Typed arrays go through as they are, not as JSON lists of numbers.
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    })
    const started: Child = { process: worker, pending: new Set(), code: codeOf(path) }
    // A crash fails each request in flight, rather than leave its caller
    // waiting for an answer that never comes.
    let ended = false
    const end = (reason: string) => {
      if (ended) return
      ended = true
      if (child === started) child = null
      for (const id of started.pending) emit({ kind: 'error', id, message: reason })
      started.pending.clear()
    }
    worker.on('message', (message: FromWorker) => {
      if (message.kind !== 'audio') started.pending.delete(message.id)
      emit(message)
    })
    worker.on('error', error => end(`could not run the local models: ${error.message}`))
    worker.on('exit', (code, signal) => end(`the local models stopped (${signal ?? `exit ${code}`})`))
    return started
  }

  return {
    post(message) {
      // Under `pnpm dev`, an edit to the worker's own code starts it again;
      // any other edit leaves the models loaded.
      if (child && message.kind === 'request' && changed(child.code)) {
        child.process.kill()
        child = null
      }
      child ??= start()
      if (message.kind === 'request') child.pending.add(message.id)
      child.process.send(message)
    },
    listen(listener) {
      listeners.add(listener)
    },
    stop() {
      child?.process.kill()
      child = null
    }
  }
}

/** The worker's files, and when each was last written, as the process started. */
type Code = Map<string, number>

function codeOf(entry: string): Code {
  const code: Code = new Map()
  const visit = (file: string) => {
    if (code.has(file)) return
    code.set(file, statSync(file).mtimeMs)
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)) {
      const path = resolve(dirname(file), specifier!)
      const found = [path, `${path}.ts`].find(candidate => existsSync(candidate) && statSync(candidate).isFile())
      if (found) visit(found)
    }
  }
  if (existsSync(entry)) visit(entry)
  return code
}

function changed(code: Code): boolean {
  for (const [file, mtimeMs] of code) {
    if (!existsSync(file) || statSync(file).mtimeMs !== mtimeMs) return true
  }
  return false
}
