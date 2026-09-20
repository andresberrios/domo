import pg from 'pg'

/**
 * Tests run against a real Postgres — the schema, the `bigserial` sequences and
 * the `REPLICA IDENTITY FULL` settings are the things most worth testing, and
 * none of them survive a fake.
 *
 * There is exactly one test database, `domo_test`, on the server that
 * `DATABASE_URL` points at (the docker-compose one by default), and it is never
 * the developer's own `domo`. `DOMO_TEST_DATABASE_URL` overrides the server.
 *
 * One stable database is zero-clutter by definition: nothing accumulates, so
 * nothing has to be swept. What it costs is parallelism between test *files* —
 * the `integration` project runs them one at a time (`fileParallelism: false`)
 * and resets the schema in between. The suite is ~13 s and most of that is the
 * Nuxt transform in a different project, so there is nothing to win there.
 */

const SERVER_URL
  = process.env.DOMO_TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:password@localhost:54321/domo'

/** The maintenance database: never the one the app uses. */
const ADMIN_DATABASE = 'postgres'

/** The one database any test may touch, named for what it is. */
export const TEST_DATABASE = 'domo_test'

/** Why Postgres could not be reached, kept for the error that ends the run. */
let unavailableReason = ''

/** Postgres's "that database already exists", which is the happy path here. */
const DUPLICATE_DATABASE = '42P04'

export function testDatabaseUrl(database: string = TEST_DATABASE): string {
  const url = new URL(SERVER_URL)
  url.pathname = `/${database}`
  return url.href
}

async function connect(database: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: testDatabaseUrl(database),
    // Fail fast instead of hanging when nobody started docker compose.
    connectionTimeoutMillis: 3000
  })
  await client.connect()
  return client
}

async function using<T>(database: string, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(database)
  try {
    return await use(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * Make sure `domo_test` exists, or return `null` — remembering why — when
 * Postgres is not running. Every caller turns that `null` into
 * `unavailableError()`; nothing is allowed to carry on without a database.
 */
export async function ensureTestDatabase(): Promise<string | null> {
  try {
    await using(ADMIN_DATABASE, async (client) => {
      try {
        await client.query(`create database "${TEST_DATABASE}"`)
      } catch (error) {
        if ((error as { code?: string }).code !== DUPLICATE_DATABASE) throw error
      }
    })
  } catch (error) {
    // A refused connection arrives as an `AggregateError` with an *empty*
    // message, so `error.message` on its own records nothing. Keep both
    // fallbacks: a blank reason once read as "the database is fine", and the
    // suite ran against — and emptied — a real `domo`.
    const reason = error instanceof Error ? error.message || error.name : String(error)
    unavailableReason = reason || 'could not connect'
    return null
  }
  unavailableReason = ''
  return testDatabaseUrl()
}

/**
 * Put the test database back to "never been booted": no tables, no sequences,
 * no types. The next `getDb()` runs `server/lib/db.ts`'s bootstrap against it
 * and produces exactly what a fresh install has, which is also what
 * `test/server/schema-migration.spec.ts` needs — it installs the *old* shape of
 * the tables by hand and cannot do that on top of the new one.
 *
 * `truncate` would be faster but not equivalent: it leaves the current schema
 * behind, so no file could ever test the migration path.
 */
export async function resetTestDatabase(): Promise<void> {
  await using(TEST_DATABASE, async (client) => {
    // Other connections are *not* terminated first. Dropping a schema needs a
    // lock on each table, not an empty database the way `drop database` does,
    // and an idle pool — a Nitro server from the e2e file that has not finished
    // shutting down, or the ElectricSQL instance that may be replicating from
    // here — holds no table locks. Terminating them would be picking a fight we
    // do not need to win. `lock_timeout` turns the one case that *is* blocked
    // into a fast, readable error instead of a hang.
    await client.query("set lock_timeout = '10s'")
    await client.query('drop schema if exists public cascade')
    await client.query('create schema public')
  })
}

/**
 * The error that ends the run. There is no opt-out: the services are a
 * precondition of the suite, and a green summary for a third of it that never
 * executed is worse than no summary at all.
 */
export function unavailableError(): Error {
  return new Error([
    `Postgres is not reachable at ${SERVER_URL.replace(/:[^:@/]*@/, ':***@')} (${unavailableReason}).`,
    '',
    'THE DATABASE-BACKED LAYERS DID NOT RUN: test/server, test/e2e, test/helpers.',
    'They cover the repo layer, the SQL schema and the migration path — the code a',
    'passing summary would be lying about here.',
    '',
    '  docker compose up -d       start the services, then run the suite again',
    ''
  ].join('\n'))
}
