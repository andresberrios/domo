import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll } from 'vitest'

import { TEST_DATABASE_PREFIX, createTestDatabase, dropTestDatabase, skipMessage } from '../helpers/database'

/**
 * `server/lib/db.ts` reads `DATABASE_URL` once, at import time, so the database
 * has to exist and the variable has to point at it before the test file — and
 * everything it imports — is loaded. That is exactly what a setup file with a
 * top-level await gives us.
 */
const database = await createTestDatabase()
const dataDir = join(tmpdir(), 'domo-test', database?.name ?? 'unavailable')

// `DATABASE_URL` always names a `domo_test_…` database, even when there is no
// Postgres to create one on. A test that forgets to skip then fails to connect,
// instead of quietly running against the developer's own `domo`.
process.env.DATABASE_URL = database?.url
  ?? `postgresql://127.0.0.1:1/${TEST_DATABASE_PREFIX}unavailable`
// Uploads, the copied mesh server and dev-environment checkouts must not land
// in the developer's real `.data` directory.
process.env.NUXT_DATA_DIR = dataDir

if (!database) console.warn(`[test] ${skipMessage()}`)

afterAll(async () => {
  if (!database) return
  const { closeDb } = await import('../../server/lib/db')
  await closeDb()
  await dropTestDatabase(database)
  await rm(dataDir, { recursive: true, force: true })
})
