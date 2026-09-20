import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestContext, loadFixture, startServer, stopServer } from '@nuxt/test-utils/e2e'

import { APP_BUILD_DIR, ensureAppBuild } from '../helpers/app-build'

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
const dataDir = join(tmpdir(), 'domo-test', 'electric-layer')

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
    throw unavailableError(`Postgres is not reachable (${reason(error)}).`, error)
  }

  if (!await electricIsUp()) {
    throw unavailableError(`ElectricSQL is not reachable at ${TEST_ELECTRIC_URL}.`)
  }

  // A clean slate for the first file; every file resets again on entry.
  await resetTestDatabase()

  createTestContext({
    rootDir,
    // The build is shared with `test/e2e` and happens in a child process; this
    // context only has to know where its output landed.
    build: false,
    server: false,
    browser: false,
    port: TEST_SERVER_PORT,
    buildDir: APP_BUILD_DIR,
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
  await ensureAppBuild()
}

/**
 * The error that ends the run. Same shape as the one the `integration` project
 * throws (`test/helpers/database.ts`): what is missing, what did not run, and
 * the one command that fixes it.
 */
function unavailableError(what: string, cause?: unknown): Error {
  return new Error([
    what,
    '',
    'THE ELECTRIC LAYER DID NOT RUN: test/electric.',
    'It is the only cover for the propagation loop — a mounted page, the real',
    'server, real Postgres, a real Electric and back into the page.',
    '',
    '  docker compose up -d       start the services, then run the suite again',
    ''
  ].join('\n'), { cause })
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
