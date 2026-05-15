import { z } from 'zod'
import { deleteProject, getProject } from '../../lib/projects'

/**
 * Remove the project from Domo's DB. Files on disk are untouched.
 *
 * Cascades to envs and sessions per the SQLite schema's `ON DELETE CASCADE`.
 * We do NOT call into coastd to remove instances — call `envs.delete` for
 * each first if you want that.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  handler: ({ input }) => {
    const existed = !!getProject(input.id)
    deleteProject(input.id)
    return { deleted: existed }
  },
})
