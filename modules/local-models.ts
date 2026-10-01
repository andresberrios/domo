import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BroadcastChannel } from 'node:worker_threads'
import { defineNuxtModule } from 'nuxt/kit'
import { dataDir } from '../server/lib/paths'
import {
  LOCAL_MODELS_CHANNEL,
  LOCAL_MODELS_HOST_ENV,
  LOCAL_MODELS_WORKER_FILE,
  createLocalModelsHost,
  sourceWorkerEntry,
  type ToWorker
} from '../server/lib/agent-voice/local-models-host'

/**
 * The open speech models' process (`server/lib/agent-voice/local-models-host.ts`),
 * from the build's side.
 *
 * In a build, its entry is a second entry of the server bundle, written next
 * to `index.mjs`, so its imports resolve the way the server's own do, and
 * the model libraries are traced into the build like any other external.
 *
 * Under `pnpm dev`, the process belongs to this thread, the dev process's
 * main one, which outlives every Nitro reload, and runs from source; Nitro's
 * worker threads reach it over a `BroadcastChannel`.
 */
export default defineNuxtModule({
  meta: { name: 'domo-local-models' },
  setup(_options, nuxt) {
    const worker = fileURLToPath(new URL('../server/lib/agent-voice/local-models-worker.ts', import.meta.url))
    nuxt.hook('nitro:init', (nitro) => {
      if (nitro.options.dev) return
      nitro.hooks.hook('rollup:before', (_nitro, config) => {
        const plugins = Array.isArray(config.plugins) ? config.plugins : config.plugins ? [config.plugins] : []
        config.plugins = [...plugins, {
          name: 'domo:local-models-worker',
          buildStart() {
            this.emitFile({ type: 'chunk', id: worker, fileName: LOCAL_MODELS_WORKER_FILE })
          },
          // A module the worker shares with the server becomes a chunk of the
          // server's, and Nitro can put it in the chunk that carries its
          // runtime: the worker would then load the whole server.
          generateBundle(_output, bundle) {
            const entry = bundle[LOCAL_MODELS_WORKER_FILE]
            const shared = entry?.type === 'chunk' ? entry.imports.filter(name => name in bundle) : []
            if (shared.length) this.error(`${LOCAL_MODELS_WORKER_FILE} imports the server's ${shared.join(', ')}; keep the worker's imports to its own modules and packages`)
          }
        }]
      })
    })

    if (!nuxt.options.dev || nuxt.options._prepare) return
    const host = createLocalModelsHost(() => sourceWorkerEntry(join(dataDir(), 'models')))
    const channel = new BroadcastChannel(LOCAL_MODELS_CHANNEL)
    channel.unref()
    channel.onmessage = event => host.post(event.data as ToWorker)
    host.listen(message => channel.postMessage(message))
    process.env[LOCAL_MODELS_HOST_ENV] = String(process.pid)
    // Nuxt itself restarting (a `nuxt.config.ts` edit, or a crash) is a new
    // instance, often in a new process, which starts models of its own.
    nuxt.hook('close', () => {
      channel.close()
      host.stop()
    })
  }
})
