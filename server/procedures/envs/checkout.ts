import { z } from 'zod'
import { coast } from '../../lib/coast'
import { getEnv } from '../../lib/envs'
import { getProject } from '../../lib/projects'

/**
 * Make this env the canonical-ports owner. Pass `id: null` to release the
 * project's checkout entirely (Coast's `--none`).
 */
export default defineProcedure({
  input: z.object({
    /** `null` = release (`coast checkout --none`). */
    id: z.string().nullable(),
    /** Required when `id` is null — we need the project to scope the call. */
    projectId: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
  handler: async ({ input }) => {
    if (input.id === null) {
      if (!input.projectId) {
        throw createError({ statusCode: 400, statusMessage: 'projectId is required when releasing checkout' })
      }
      const project = getProject(input.projectId)
      if (!project) throw createError({ statusCode: 404, statusMessage: 'project not found' })
      await coast().checkout(project.name, null)
      return { ok: true }
    }

    const env = getEnv(input.id)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    const project = getProject(env.projectId)
    if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })
    await coast().checkout(project.name, env.coastInstanceName)
    return { ok: true }
  },
})
