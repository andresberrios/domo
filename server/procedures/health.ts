import { z } from 'zod'
import { db } from '../lib/db'
import { domoHome } from '../lib/paths'

/**
 * Smoke procedure — confirms the SQLite handle opens, the data dir
 * resolves, and the schema rows are queryable.
 */
export default defineProcedure({
  output: z.object({
    ok: z.literal(true),
    domoHome: z.string(),
    projects: z.number().int(),
    schemaVersion: z.number().int(),
  }),
  handler: () => {
    const handle = db()
    const projects = (handle.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n
    const schemaVersion = (handle.prepare(`SELECT version FROM schema_version`).get() as { version: number }).version
    return {
      ok: true as const,
      domoHome: domoHome(),
      projects,
      schemaVersion,
    }
  },
})
