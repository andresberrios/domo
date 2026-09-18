/**
 * Wiring for the `electric` test layer.
 *
 * This layer is the only one where the *whole* loop is real: a page mounted in
 * happy-dom → the real Nitro server → real Postgres → a real ElectricSQL →
 * back into the mounted page's live query. Nothing in it polls.
 *
 * It is deliberately standalone — it does not reuse `test/helpers/database.ts`
 * or `test/setup/` — because those give the database-backed layers a database
 * they are free to reset however they like, and an Electric instance cannot be
 * stood up per file. This layer needs the opposite: one long-lived database an
 * Electric container is already bound to, reset only in ways that leave that
 * binding intact. See `docker-compose.yml` (`postgres-e2e-db` + `electric-e2e`).
 */
import pg from 'pg'

export { TEST_SERVER_ORIGIN, TEST_SERVER_PORT } from './origin'

/**
 * This layer's own database — not `domo_test`.
 *
 * `domo_test` is reset with `drop schema public cascade`, which drops every
 * table out of Electric's publication. The replication slot and the publication
 * both survive that, so Electric goes on looking healthy while replicating
 * nothing: shapes return their initial snapshot and then never change again.
 * A separate database keeps this layer out of that blast radius.
 */
export const TEST_DATABASE = 'domo_e2e'

export const POSTGRES_SERVER_URL
  = process.env.DOMO_E2E_DATABASE_URL || 'postgresql://postgres:password@localhost:54321/postgres'

/** The *second* Electric (port 30001). Never 30000 — that one is the developer's. */
export const TEST_ELECTRIC_URL = process.env.DOMO_E2E_ELECTRIC_URL || 'http://localhost:30001'

function databaseUrl(database: string): string {
  const url = new URL(POSTGRES_SERVER_URL)
  url.pathname = `/${database}`
  return url.href
}

export const TEST_DATABASE_URL = databaseUrl(TEST_DATABASE)

async function withClient<T>(connectionString: string, use: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 })
  await client.connect()
  try {
    return await use(client)
  } finally {
    await client.end().catch(() => {})
  }
}

export function withTestDatabase<T>(use: (client: pg.Client) => Promise<T>): Promise<T> {
  return withClient(TEST_DATABASE_URL, use)
}

/** Idempotent; docker-compose does this too, but a developer may have dropped it. */
export async function ensureTestDatabase(): Promise<void> {
  await withClient(POSTGRES_SERVER_URL, async (client) => {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [TEST_DATABASE])
    if (!rowCount) await client.query(`create database "${TEST_DATABASE}"`)
  })
}

/**
 * Empty the tables between files with ordinary `delete`.
 *
 * Not `drop schema`: that removes every table from Electric's publication, and
 * the re-created ones are not members, so the instance stays up and replicates
 * nothing. Not `drop database` either: Postgres refuses outright while a
 * replication slot is attached (`database "domo_e2e" is used by an active
 * logical replication slot`), and a slot left behind holds WAL forever.
 *
 * `truncate` does work — measured against a live Electric, it answers the next
 * poll with `must-refetch`, the client resyncs from a fresh snapshot, and
 * subsequent writes arrive normally. But it invalidates every shape on the
 * table, so each test would start by re-downloading everything. `delete` is
 * plain DML that decodes the way every other write in the suite does, and these
 * tables hold tens of rows.
 */
export async function resetTestDatabase(): Promise<void> {
  await withTestDatabase(async (client) => {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`
    )
    if (!rows.length) return
    // Order does not matter: every foreign key in the schema is `on delete
    // cascade` or `on delete set null`, so no delete can be refused.
    const deletes = rows.map(row => `delete from "public"."${row.tablename}"`).join('; ')
    await client.query(`begin; ${deletes}; commit`)
  })
}

export async function electricIsUp(): Promise<boolean> {
  try {
    const response = await fetch(new URL('/v1/health', TEST_ELECTRIC_URL))
    return response.ok
  } catch {
    return false
  }
}

/**
 * What Electric can actually see. Membership is demand-driven — Electric adds a
 * table when a shape first asks for it — and a table silently falling *out* of
 * the publication is the failure this layer is most exposed to, because shapes
 * go on answering and simply stop changing.
 */
export async function publishedTables(): Promise<string[]> {
  return withTestDatabase(async (client) => {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_publication_tables where schemaname = 'public' order by tablename`
    )
    return rows.map(row => row.tablename)
  })
}
