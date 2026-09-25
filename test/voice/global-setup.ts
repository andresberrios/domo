import { access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestContext, loadFixture, startServer, stopServer } from '@nuxt/test-utils/e2e'
import { chromium } from 'playwright-core'

import { APP_BUILD_DIR, ensureAppBuild } from '../helpers/app-build'
import { chromiumPath } from '../helpers/browser'
import {
  TEST_DATABASE_URL,
  TEST_ELECTRIC_URL,
  electricIsUp,
  ensureTestDatabase,
  resetTestDatabase
} from '../electric/harness'
import { VOICE_SERVER_PORT } from './origin'

/**
 * What the `voice-live` layer needs, checked once, before a single test
 * reports, with no skip and no opt-out.
 *
 * It borrows the `electric` layer's database and Electric instance
 * (`domo_e2e`, the `electric-e2e` container) rather than the `integration`
 * one, and that is not a convenience — **it is the whole reason the layer
 * works**. The e2e Electric stub answers every shape with one hardcoded
 * `projects` row, which is fine for `test/e2e` because it never renders a
 * page; a real browser loading the real app gets no conversation, no
 * transcript and no sidebar out of it. The page needs rows that really
 * stream, so it needs the Electric that really streams them. The two layers
 * never run at once (each is its own opt-in command) and both reset on entry,
 * so sharing the database is safe; the server port is its own so that running
 * both back to back cannot collide.
 *
 * It also needs a **real OpenAI key** and bills what it spends, which is why
 * it can never join `pnpm test`. Opt in with `pnpm test:voice`.
 */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = join(tmpdir(), 'domo-test', 'voice-layer')

export default async function setup() {
  await prepare()
  await startServer()

  return async () => {
    await stopServer()
    await rm(dataDir, { recursive: true, force: true })
  }
}

async function chromiumProblem(): Promise<string | null> {
  const explicit = chromiumPath()
  if (explicit) {
    const reachable = await access(explicit).then(() => true, () => false)
    return reachable ? null : `DOMO_TEST_CHROMIUM points at ${explicit}, which does not exist.`
  }
  try {
    // Playwright resolves its own download here and throws if it is missing.
    chromium.executablePath()
    return null
  } catch {
    return 'No Chromium for Playwright. Run `npx playwright install chromium`, '
      + 'or point DOMO_TEST_CHROMIUM at an existing Chrome/Chromium binary.'
  }
}

async function prepare(): Promise<void> {
  const missing: string[] = []

  try {
    await ensureTestDatabase()
  } catch (error) {
    missing.push(`Postgres is not reachable (${reason(error)}).`)
  }
  if (!await electricIsUp()) missing.push(`ElectricSQL is not reachable at ${TEST_ELECTRIC_URL}.`)

  // The one credential the layer is *about*. There is deliberately no fallback
  // to a fake server: a fake proves Domo talks to something, and the failures
  // worth catching here are the ones only the real API produces.
  const key = process.env.NUXT_OPENAI_API_KEY || process.env.OPENAI_API_KEY
  if (!key) {
    missing.push(
      'No OpenAI API key. Export NUXT_OPENAI_API_KEY — this layer runs real '
      + 'GPT-Live sessions and bills them.'
    )
  }

  const browser = await chromiumProblem()
  if (browser) missing.push(browser)

  if (missing.length) throw unavailableError(missing)

  await resetTestDatabase()

  createTestContext({
    rootDir,
    build: false,
    server: false,
    browser: false,
    port: VOICE_SERVER_PORT,
    buildDir: APP_BUILD_DIR,
    env: {
      // Explicit, never inherited: a leaked DATABASE_URL would write to the
      // developer's own `domo`.
      DATABASE_URL: TEST_DATABASE_URL,
      ELECTRIC_URL: TEST_ELECTRIC_URL,
      NUXT_DATA_DIR: dataDir,
      NUXT_OPENAI_API_KEY: key!,
      NUXT_GEMINI_API_KEY: '',
      NUXT_ANTHROPIC_API_KEY: '',
      // No coding agent may spawn, and the usage poller must not reach an
      // account on boot — the same three locks `test/e2e` uses.
      NUXT_CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      NUXT_ANTHROPIC_API_BASE: 'http://127.0.0.1:1',
      NUXT_CLAUDE_ACP_ENTRY: join(rootDir, 'test', 'helpers', 'dead-adapter.mjs'),
      NUXT_CODEX_ACP_ENTRY: join(rootDir, 'test', 'helpers', 'dead-adapter.mjs'),
      NUXT_OPENCODE_ACP_ENTRY: join(rootDir, 'test', 'helpers', 'dead-adapter.mjs'),
      NUXT_CODEX_ENTRY: join(rootDir, 'test', 'helpers', 'dead-adapter.mjs')
    }
  })
  await loadFixture()
  await ensureAppBuild()
}

function unavailableError(missing: string[]): Error {
  return new Error([
    `The voice-live layer did not run:`,
    ...missing.map(line => `  - ${line}`),
    '',
    'It is the only cover for the browser half of the voice agent — a real',
    'microphone, the real app, and a real GPT-Live session. Nothing in it is',
    'faked, so it needs a key and it spends money.',
    '',
    '  docker compose up -d                      start Postgres and Electric',
    '  export NUXT_OPENAI_API_KEY=sk-...         the account it runs against',
    '  npx playwright install chromium           or set DOMO_TEST_CHROMIUM',
    ''
  ].join('\n'))
}

function reason(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}
