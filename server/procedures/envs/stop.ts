import { z } from 'zod'
import { coast } from '../../lib/coast'
import { getEnv, updateEnvStatus } from '../../lib/envs'
import { getProject } from '../../lib/projects'

export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    const project = getProject(env.projectId)
    if (!project) throw createError({ statusCode: 500, statusMessage: 'project missing' })
    await coast().stop(env.coastInstanceName, project.name)
    updateEnvStatus(env.id, 'stopped')
    return { ok: true }
  },
})
