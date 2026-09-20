import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createTestContext, loadFixture, startServer, stopServer } from '@nuxt/test-utils/e2e'

import {
  TEST_DATABASE_URL,
  TEST_ELECTRIC_URL,
  TEST_SERVER_PORT,
  electricIsUp,
  ensureTestDatabase,
  resetTestDatabase
} from './harness'

/**
 * One Nitro server for the whole project, started once, pointed at the
 * database that the `electric-e2e` container is bound to (`domo_e2e`).
 *
 * `fileParallelism` is off for this project, so a single pinned port and a
 * single database are safe: the files run one after another, and each one
 * resets on the way in.
 */
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const buildDir = resolve(rootDir, '.nuxt/test/electric')
const dataDir = join(tmpdir(), 'domo-test', 'electric-layer')

const run = promisify(execFile)

export default async function setup() {
  await prepare()
  await startServer()

  return async () => {
    await stopServer()
    await rm(dataDir, { recursive: true, force: true })
  }
}

/**
 * Everything the layer needs before a single test reports, and an exit code
 * when it is missing. The services are a precondition of the suite, not a
 * branch: a layer that skipped itself would report green for the one loop
 * nothing else covers.
 */
async function prepare(): Promise<void> {
  try {
    await ensureTestDatabase()
  } catch (error) {
    throw new Error(
      `Postgres is not reachable (${reason(error)}). Start it with \`docker compose up -d\`.`,
      { cause: error }
    )
  }

  if (!await electricIsUp()) {
    throw new Error(
      `ElectricSQL is not reachable at ${TEST_ELECTRIC_URL}. `
      + 'Start it with `docker compose up -d electric-e2e`.'
    )
  }

  // A clean slate for the first file; every file resets again on entry.
  await resetTestDatabase()

  createTestContext({
    rootDir,
    // The build happens below, in a child process; this context only has to
    // know where its output landed.
    build: false,
    server: false,
    browser: false,
    port: TEST_SERVER_PORT,
    buildDir,
    env: {
      // Explicit, never inherited: a leaked DATABASE_URL would write to the
      // developer's own `domo`, and these assertions would not notice.
      DATABASE_URL: TEST_DATABASE_URL,
      ELECTRIC_URL: TEST_ELECTRIC_URL,
      NUXT_DATA_DIR: dataDir,
      NUXT_GEMINI_API_KEY: '',
      NUXT_ANTHROPIC_API_KEY: '',
      NUXT_CODEX_API_KEY: '',
      NUXT_OPENAI_API_KEY: ''
    }
  })
  await loadFixture()

  try {
    // Output is held back and only printed when the build fails: a successful
    // Nuxt build prints its entire asset manifest.
    await run(process.execPath, [resolve(rootDir, 'test/electric/build.mjs'), buildDir], {
      cwd: rootDir,
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (error) {
    const streams = error as { stdout?: string, stderr?: string }
    const output = streams.stdout || streams.stderr
      ? `${streams.stdout ?? ''}\n${streams.stderr ?? ''}`
      : reason(error)
    throw new Error(`The app failed to build:\n${output}`, { cause: error })
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
