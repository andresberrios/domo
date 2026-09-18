import { randomUUID } from 'node:crypto'

import pg from 'pg'

/**
 * Tests run against a real Postgres — the schema, the `bigserial` sequences and
 * the `REPLICA IDENTITY FULL` settings are the things most worth testing, and
 * none of them survive a fake.
 *
 * Every test *file* gets its own throwaway database on the server that
 * `DATABASE_URL` points at (the docker-compose one by default), so files stay
 * isolated from each other and the developer's own `domo` database is never
 * written to. `DOMO_TEST_DATABASE_URL` overrides the server to use.
 */

const SERVER_URL
  = process.env.DOMO_TEST_DATABASE_URL
    || process.env.DATABASE_URL
    || 'postgresql://postgres:password@localhost:54321/domo'

/** The maintenance database: never the one the app uses. */
const ADMIN_DATABASE = 'postgres'

/** Anything a test may connect to is named for what it is, and nothing else is. */
export const TEST_DATABASE_PREFIX = 'domo_test_'

/**
 * The skip reason travels through the environment rather than through module
 * state: a setup file and the test file it sets up do not always share a module
 * registry, and a test that quietly fell through to the developer's own
 * database instead of skipping would be worse than a failing one.
 */
const UNAVAILABLE_ENV = 'DOMO_TEST_DATABASE_UNAVAILABLE'

export interface TestDatabase {
  name: string
  url: string
}

function urlFor(database: string): string {
  const url = new URL(SERVER_URL)
  url.pathname = `/${database}`
  return url.href
}

async function admin<T>(use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: urlFor(ADMIN_DATABASE),
    // Fail fast instead of hanging when nobody started docker compose.
    connectionTimeoutMillis: 3000
  })
  await client.connect()
  try {
    return await use(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/**
 * Create an empty database for the current test file, or return `null` with a
 * reason on the environment when Postgres is not running — a skipped suite
 * beats a cryptic hang.
 */
export async function createTestDatabase(): Promise<TestDatabase | null> {
  const name = `${TEST_DATABASE_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`
  try {
    await admin(client => client.query(`create database "${name}"`))
  } catch (error) {
    // An empty reason would read as "available" through the environment, and a
    // refused connection arrives as an AggregateError with no message at all.
    const reason = error instanceof Error ? error.message || error.name : String(error)
    process.env[UNAVAILABLE_ENV] = reason || 'could not connect'
    return null
  }
  process.env[UNAVAILABLE_ENV] = ''
  return { name, url: urlFor(name) }
}

export async function dropTestDatabase(database: TestDatabase): Promise<void> {
  // `force` terminates anything still connected: the pool in this process, or a
  // Nitro server that has not finished shutting down yet.
  await admin(client => client.query(`drop database if exists "${database.name}" with (force)`))
    .catch(error => console.warn(`[test] could not drop ${database.name}:`, error))
}

/** Why the database-backed suites are being skipped, if they are. */
export function databaseUnavailable(): string | null {
  return process.env[UNAVAILABLE_ENV] || null
}

export function skipMessage(): string {
  return `Postgres is not reachable at ${SERVER_URL.replace(/:[^:@/]*@/, ':***@')} `
    + `(${databaseUnavailable()}). Start it with \`docker compose up -d\`.`
}
