/**
 * Build the app for the layers that drive a real server, in a child process.
 *
 * Not in-process: a Nuxt build run inside Vitest's *main* process takes its
 * stdout with it, and the test report never appears. Both callers now build
 * from a `globalSetup`, which is the main process.
 *
 *   node test/helpers/build-app.mjs <buildDir>
 */
import Module from 'node:module'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const buildDir = process.argv[2]
if (!buildDir) throw new Error('usage: node test/helpers/build-app.mjs <buildDir>')

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// pnpm leaves transitive packages unhoisted, and `@nuxt/ui` has to resolve
// `tailwindcss` from *somewhere* to alias it for the CSS build. pnpm's own bin
// shims export this on `NODE_PATH`, so a build launched through `pnpm test`
// works by accident; say it out loud instead. A no-op on a flat node_modules.
const store = resolve(rootDir, 'node_modules/.pnpm/node_modules')
process.env.NODE_PATH = [store, process.env.NODE_PATH].filter(Boolean).join(delimiter)
Module._initPaths()

const { buildNuxt, loadNuxt } = await import('nuxt/kit')

const nuxt = await loadNuxt({
  cwd: rootDir,
  dev: false,
  overrides: {
    buildDir,
    nitro: { output: { dir: resolve(buildDir, 'output') } }
  }
})

try {
  await buildNuxt(nuxt)
} finally {
  await nuxt.close()
}
