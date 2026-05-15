import { z } from 'zod'
import { Env } from '../../lib/schemas'
import { getProject } from '../../lib/projects'
import { listEnvsEnriched } from '../../lib/envs'

/**
 * List envs for a project, with coastd live status folded in. If coastd
 * is unreachable we still return the cached rows (with `liveStatus: null`)
 * so the left-rail tree can render.
 */
export default defineProcedure({
  input: z.object({ projectId: z.string() }),
  output: z.array(Env),
  handler: async ({ input }) => {
    const project = getProject(input.projectId)
    if (!project) {
      throw createError({ statusCode: 404, statusMessage: 'project not found' })
    }
    return listEnvsEnriched(project.name, project.id)
  },
})
