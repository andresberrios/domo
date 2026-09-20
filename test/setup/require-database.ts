import { ensureTestDatabase, unavailableError } from '../helpers/database'

/**
 * The once-per-run half of the test-database lifecycle
 * (`test/setup/database.ts` is the per-file half). A Vitest `globalSetup` on
 * the `integration` project, so it runs in the main process before any worker
 * forks and not at all for the service-free projects.
 *
 * Its whole job is to turn "Postgres is not running" into an exit code *here*,
 * before a single test has reported. The database-backed files used to skip
 * themselves, and the suite printed a green "263 passed" with a third of it —
 * the repo layer, the SQL schema, the migration path — never executed. A
 * warning scrolls past; an exit code does not. Failing once, up front, also
 * beats failing in all five files with the same wall of text.
 *
 * It creates `domo_test` on the way, so the per-file setup only ever has to
 * empty it.
 */
export async function setup(): Promise<void> {
  if (!await ensureTestDatabase()) throw unavailableError()
}
