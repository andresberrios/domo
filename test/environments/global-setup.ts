import { execFile } from 'node:child_process'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
import { ENVIRONMENTS_PREFIX, ENVIRONMENTS_SERVER_ORIGIN, ENVIRONMENTS_SERVER_PORT } from './origin'

/**
 * What the `environments-live` layer needs, checked once, with no skip: the
 * real app on a real server, a real Docker daemon, and a real Chromium, so the
 * new-environment dialog, creation, the branch an environment works on and
 * retirement are driven the way a person does it.
 *
 * It borrows `domo_e2e` and the `electric-e2e` Electric, like `voice-live`
 * and for the same reason: a page needs rows that really stream. The layers
 * reset it on entry and never run at once. Opt in with `pnpm test:environments`.
 *
 * The server never sees the developer's own anything: its own data directory,
 * home overlay and tool config directories under a scratch root, its own
 * resource prefix, and no account. Its runtime volume is kept between runs
 * (building it is the slow part); everything else it made is removed here.
 */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** Shared with the spec, which puts its fixture repositories here. */
export const SCRATCH = join(tmpdir(), 'domo-test', 'environments-layer')
const dataDir = join(SCRATCH, 'data')
const dead = join(rootDir, 'test', 'helpers', 'dead-adapter.mjs')
const run = promisify(execFile)

export default async function setup() {
  await prepare()
  await startServer()

  return async () => {
    // Whatever a failed test left running goes the way a person would retire it.
    await retireEverything().catch(error => console.warn(`[environments-live] cleanup: ${error}`))
    await stopServer()
    await removeResources()
    await rm(SCRATCH, { recursive: true, force: true })
  }
}

async function prepare(): Promise<void> {
  const missing: string[] = []
  try {
    await ensureTestDatabase()
  } catch (error) {
    missing.push(`Postgres is not reachable (${error instanceof Error ? error.message || error.name : String(error)}).`)
  }
  if (!await electricIsUp()) missing.push(`ElectricSQL is not reachable at ${TEST_ELECTRIC_URL}.`)
  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}']).then(() => true, () => false)
  if (!docker) missing.push('Docker is not answering. Start Docker Desktop (or your daemon).')
  const browser = await chromiumProblem()
  if (browser) missing.push(browser)
  if (missing.length) {
    throw new Error(['The environments-live layer did not run:', ...missing.map(line => `  - ${line}`), ''].join('\n'))
  }

  await rm(SCRATCH, { recursive: true, force: true })
  // A stand-in home: never the developer's ~/.ssh or ~/.gitconfig.
  const home = join(SCRATCH, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = Domo Environments Test\n\temail = envlive@example.com\n')
  for (const dir of ['claude', 'codex']) await mkdir(join(SCRATCH, dir), { recursive: true })
  await resetTestDatabase()

  createTestContext({
    rootDir,
    build: false,
    server: false,
    browser: false,
    port: ENVIRONMENTS_SERVER_PORT,
    buildDir: APP_BUILD_DIR,
    env: {
      // Explicit, never inherited: a leaked DATABASE_URL would write to the developer's own `domo`.
      DATABASE_URL: TEST_DATABASE_URL,
      ELECTRIC_URL: TEST_ELECTRIC_URL,
      NUXT_DATA_DIR: dataDir,
      NUXT_DEV_ENV_RESOURCE_PREFIX: ENVIRONMENTS_PREFIX,
      NUXT_HOME_OVERLAY_DIR: home,
      NUXT_CLAUDE_CONFIG_DIR: join(SCRATCH, 'claude'),
      NUXT_CODEX_CONFIG_DIR: join(SCRATCH, 'codex'),
      NUXT_OPENAI_API_KEY: '',
      NUXT_GEMINI_API_KEY: '',
      NUXT_ANTHROPIC_API_KEY: '',
      NUXT_OPENCODE_API_KEY: '',
      NUXT_CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      NUXT_ANTHROPIC_API_BASE: 'http://127.0.0.1:1',
      NUXT_CLAUDE_ACP_ENTRY: dead,
      NUXT_CODEX_ACP_ENTRY: dead,
      NUXT_OPENCODE_ACP_ENTRY: dead,
      NUXT_CODEX_ENTRY: dead
    }
  })
  await loadFixture()
  await ensureAppBuild()
}

async function chromiumProblem(): Promise<string | null> {
  const explicit = chromiumPath()
  if (explicit) {
    return await access(explicit).then(() => null, () => `DOMO_TEST_CHROMIUM points at ${explicit}, which does not exist.`)
  }
  try {
    await access(chromium.executablePath())
    return null
  } catch {
    return 'No Chromium for Playwright. Run `npx playwright install chromium`, or set DOMO_TEST_CHROMIUM.'
  }
}

async function retireEverything(): Promise<void> {
  const response = await fetch(new URL('/api/dev-environments', ENVIRONMENTS_SERVER_ORIGIN))
  if (!response.ok) return
  for (const environment of await response.json() as Array<{ id: string, retiredAt: string | null }>) {
    if (environment.retiredAt) continue
    await fetch(new URL(`/api/dev-environments/${environment.id}`, ENVIRONMENTS_SERVER_ORIGIN), { method: 'DELETE' })
  }
}

/** The port helper and the cache volume this prefix made. The runtime volume stays for the next run. */
async function removeResources(): Promise<void> {
  process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = ENVIRONMENTS_PREFIX
  process.env.NUXT_DATA_DIR = dataDir
  const { portHelperImage, portHelperName } = await import('../../server/lib/dev-env/port-helper')
  const { sharedCacheVolumeName } = await import('../../server/lib/dev-env/caches')
  const { doodSocketDir } = await import('../../server/lib/dood/manager')
  const quiet = (args: string[]) => run('docker', args).catch(() => null)
  await quiet(['rm', '--force', portHelperName()])
  await quiet(['image', 'rm', portHelperImage()])
  await quiet(['volume', 'rm', sharedCacheVolumeName()])
  await rm(doodSocketDir(), { recursive: true, force: true })
}

export { ENVIRONMENTS_SERVER_ORIGIN }
