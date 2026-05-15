import { z } from 'zod'
import { coast, CoastError } from '../../lib/coast'
import { deleteEnv, getEnv } from '../../lib/envs'
import { getProject } from '../../lib/projects'

/**
 * Tear down the Coast instance and remove the env row.
 *
 * coastd's `/rm` cleans up the container + the worktree it manages. We do
 * not separately delete the on-disk worktree dir — coast owns that path.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) return { deleted: false }
    const project = getProject(env.projectId)
    if (project) {
      try {
        await coast().rm(env.coastInstanceName, project.name)
      } catch (e) {
        // If the instance is already gone from coastd's side, that's fine;
        // surface any other failure so the user can retry.
        if (!(e instanceof CoastError) || e.status !== 404) throw e
      }
    }
    deleteEnv(env.id)
    return { deleted: true }
  },
})
