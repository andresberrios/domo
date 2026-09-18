import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { TEST_DATABASE, databaseUnavailable, resetTestDatabase, skipMessage, testDatabaseUrl } from './database'

/**
 * The harness's own test. One shared database means the reset between files is
 * load-bearing: everything else assumes it hands over a database that looks
 * like one the app has never booted against.
 */
const skip = !!databaseUnavailable()
if (skip) console.warn(`[test] ${skipMessage()}`)

async function onTestDatabase<T>(use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 })
  await client.connect()
  try {
    return await use(client)
  } finally {
    await client.end().catch(() => {})
  }
}

async function tablesInPublic(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
  )
  return rows.map(row => row.table_name)
}

describe.skipIf(skip)('resetTestDatabase', () => {
  it('is only ever the test database, never the app\'s own', () => {
    expect(TEST_DATABASE).toBe('domo_test')
    expect(new URL(testDatabaseUrl()).pathname).not.toBe('/domo')
  })

  it('leaves no trace of the previous file', async () => {
    await onTestDatabase(async (client) => {
      await client.query('create table leftover (id text primary key)')
      await client.query(`insert into leftover values ('row')`)
    })

    await resetTestDatabase()

    const tables = await onTestDatabase(tablesInPublic)
    expect(tables).toEqual([])
  })

  it('leaves a schema the app can boot into', async () => {
    await resetTestDatabase()

    // The bootstrap in `server/lib/db.ts` is the real subject here: a reset that
    // left `public` missing, or owned by nobody, would fail on the first boot
    // rather than in this file.
    const { closeDb, getDb } = await import('../../server/lib/db')
    await closeDb()
    await getDb()

    const tables = await onTestDatabase(tablesInPublic)
    expect(tables).toContain('voice_sessions')
    expect(tables).toContain('agent_events')

    // `REPLICA IDENTITY FULL` is a property of a table in `public`, and Electric
    // depends on it — a reset that broke the schema's shape would lose it.
    const identities = await onTestDatabase(async client => client.query<{ relreplident: string }>(
      `select relreplident from pg_class join pg_namespace on pg_namespace.oid = relnamespace
        where nspname = 'public' and relname = 'voice_sessions'`
    ))
    expect(identities.rows[0]?.relreplident).toBe('f')

    await closeDb()
  })

  it('works while another connection is still attached', async () => {
    // A Nitro server from the e2e file may not have finished shutting down, and
    // an ElectricSQL instance may be replicating from this database. Neither
    // holds a table lock while idle, so the reset neither blocks on them nor
    // terminates them.
    const squatter = new pg.Client({ connectionString: testDatabaseUrl(), connectionTimeoutMillis: 3000 })
    await squatter.connect()
    await squatter.query('create table squatted (id text primary key)')

    await expect(resetTestDatabase()).resolves.toBeUndefined()

    const tables = await onTestDatabase(tablesInPublic)
    expect(tables).toEqual([])

    // Still connected, and still usable — nothing was killed on its behalf.
    await expect(squatter.query('select 1')).resolves.toBeTruthy()
    await squatter.end().catch(() => {})
  })
})
