import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll } from 'vitest'

import {
  TEST_DATABASE,
  ensureTestDatabase,
  resetTestDatabase,
  skipAllowed,
  skipMessage,
  unavailableError
} from '../helpers/database'

/**
 * The per-file half of the test-database lifecycle; `test/setup/require-database.ts`
 * is the once-per-run half.
 *
 * `server/lib/db.ts` reads `DATABASE_URL` once, at import time, and bootstraps
 * the schema on its first connection. So the database has to exist, be empty,
 * and be named by the variable before the test file — and everything it imports
 * — is loaded. That is exactly what a setup file with a top-level await gives us.
 *
 * Emptying it here rather than in an `afterAll` is deliberate: a file that
 * crashes cannot leave the next one a dirty database, because the next one
 * cleans before it starts. Files never overlap — the `integration` project sets
 * `fileParallelism: false`.
 */
const url = await ensureTestDatabase()
if (url) await resetTestDatabase()

// `DATABASE_URL` always names the test database, even when there is no Postgres
// to reach. A test that forgets to skip then fails to connect, instead of
// quietly running against the developer's own `domo`.
process.env.DATABASE_URL = url ?? `postgresql://127.0.0.1:1/${TEST_DATABASE}`

// Uploads, the copied mesh server and dev-environment checkouts must not land
// in the developer's real `.data` directory. One directory per file, so a
// leftover from one cannot be read by the next.
const dataDir = join(tmpdir(), 'domo-test', randomUUID().slice(0, 8))
process.env.NUXT_DATA_DIR = dataDir

// The run-level setup normally catches this first; this covers a database that
// went away mid-run, and any future project that forgets that setup.
if (!url && !skipAllowed()) throw unavailableError()
if (!url) console.warn(`[test] ${skipMessage()}`)

afterAll(async () => {
  if (url) {
    const { closeDb } = await import('../../server/lib/db')
    await closeDb()
  }
  await rm(dataDir, { recursive: true, force: true })
})
