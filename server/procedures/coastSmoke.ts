import { z } from 'zod'
import { coast, CoastError } from '../lib/coast'

/**
 * Smoke-test the Coast adapter against the running coastd. Hits `/ls`
 * (REST), validates the response against our Zod schema, and reports the
 * instance count + known-projects count.
 */
export default defineProcedure({
  output: z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      baseUrl: z.string(),
      instances: z.number().int(),
      knownProjects: z.number().int(),
      sample: z.array(z.object({
        name: z.string(),
        project: z.string(),
        status: z.string(),
        worktree: z.string().nullable().optional(),
      })),
    }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
      status: z.number().int().optional(),
      body: z.unknown().optional(),
    }),
  ]),
  handler: async () => {
    const client = coast()
    try {
      const reachable = await client.ping()
      if (!reachable) {
        return { ok: false as const, error: `coastd unreachable at ${client.baseUrl}` }
      }
      const ls = await client.ls()
      return {
        ok: true as const,
        baseUrl: client.baseUrl,
        instances: ls.instances.length,
        knownProjects: ls.known_projects.length,
        sample: ls.instances.slice(0, 3).map((i) => ({
          name: i.name,
          project: i.project,
          status: i.status,
          worktree: i.worktree ?? null,
        })),
      }
    } catch (e) {
      if (e instanceof CoastError) {
        return { ok: false as const, error: e.message, status: e.status, body: e.body }
      }
      throw e
    }
  },
})
