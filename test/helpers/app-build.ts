import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * One production build of the app per run, shared by the two layers that drive
 * a real Nitro server: `test/e2e` (the `integration` project) and
 * `test/electric`. They only differ in the environment their server is started
 * with, so building twice cost ~15 s for nothing.
 *
 * A fixed directory rather than the random `.nuxt/test/<id>` that
 * `@nuxt/test-utils` picks by default, which used to leak ~40 MB per run when a
 * run did not tear down cleanly. It is rebuilt every run, so it is never stale.
 */
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const APP_BUILD_DIR = resolve(rootDir, '.nuxt/test/app')

/**
 * The "already built" mark lives on the environment, not in module state:
 * Vitest runs each project's `globalSetup` in the main process but with its own
 * module registry, so the two callers import two copies of this file. They run
 * one after another, never concurrently, so a flag is enough — no lock.
 */
const BUILT_ENV = 'DOMO_TEST_APP_BUILT'

const run = promisify(execFile)

export async function ensureAppBuild(): Promise<string> {
  if (process.env[BUILT_ENV] === APP_BUILD_DIR) return APP_BUILD_DIR

  try {
    // Output is held back and only printed when the build fails: a successful
    // Nuxt build prints its entire asset manifest.
    await run(process.execPath, [resolve(rootDir, 'test/helpers/build-app.mjs'), APP_BUILD_DIR], {
      cwd: rootDir,
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (error) {
    const streams = error as { stdout?: string, stderr?: string }
    const output = streams.stdout || streams.stderr
      ? `${streams.stdout ?? ''}\n${streams.stderr ?? ''}`
      : error instanceof Error ? error.message || error.name : String(error)
    throw new Error(`The app failed to build:\n${output}`, { cause: error })
  }

  process.env[BUILT_ENV] = APP_BUILD_DIR
  return APP_BUILD_DIR
}
