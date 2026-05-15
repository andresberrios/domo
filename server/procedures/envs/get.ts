import { z } from 'zod'
import { Env } from '../../lib/schemas'
import { getEnv } from '../../lib/envs'
import { getProject } from '../../lib/projects'
import { coast } from '../../lib/coast'

/**
 * Fetch one env by id, with a fresh `/lookup` snapshot for its live
 * status. Used by the env overview page.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: Env.nullable(),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) return null
    const project = getProject(env.projectId)
    if (!project) return env

    try {
      const lookup = await coast().lookup({ project: project.name })
      const instance = lookup.instances.find((i) => i.name === env.coastInstanceName)
      return {
        ...env,
        liveStatus: instance?.status ?? null,
        checkedOut: instance?.checked_out ?? false,
      }
    } catch {
      return { ...env, liveStatus: null, checkedOut: false }
    }
  },
})
