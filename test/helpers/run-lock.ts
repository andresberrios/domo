import pg from 'pg'

/**
 * Claim a test database for a whole run, waiting while another run has it.
 *
 * Every checkout on a machine uses the same test databases on the same
 * Postgres, and two runs at once empty each other's tables mid-test: the
 * failures look like foreign-key bugs. The claim is a session advisory lock
 * on the server's maintenance database, so Postgres frees it when the holding
 * run's connection goes, however that run ended.
 *
 * Returns the release. Call it from the `globalSetup` teardown.
 */
export async function claimTestDatabase(serverUrl: string, database: string): Promise<() => Promise<void>> {
  const url = new URL(serverUrl)
  url.pathname = '/postgres'
  // Postgres keeps 63 bytes of it; the end of the path is what tells checkouts apart.
  const prefix = `domo-test ${database} `
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: 3000,
    application_name: prefix + process.cwd().slice(-(63 - prefix.length))
  })
  await client.connect()
  const key = `domo-test:${database}`
  try {
    const { rows: [claim] } = await client.query('select pg_try_advisory_lock(hashtext($1)) as ok', [key])
    if (!claim.ok) {
      const { rows } = await client.query(
        'select application_name from pg_stat_activity where application_name like $1 and pid <> pg_backend_pid()',
        [`${prefix}%`]
      )
      const holders = rows.map(row => row.application_name.slice(prefix.length)).join(', ') || 'unknown'
      console.warn(`[test] Another test run is using ${database} (${holders}). Waiting for it to finish.`)
      await client.query('select pg_advisory_lock(hashtext($1))', [key])
    }
  } catch (error) {
    await client.end().catch(() => {})
    throw error
  }
  return () => client.end().catch(() => {})
}
