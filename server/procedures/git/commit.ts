import { z } from 'zod'
import { GitError, gitCommit } from '../../lib/git'
import { resolveEnvWorktree } from '../../lib/workspace'

/** Commit whatever is staged. The UI gates the button on a non-empty
 * message and a non-empty staged list, but git still enforces both. */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    message: z.string().min(1),
  }),
  output: z.object({ hash: z.string() }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)
    try {
      return await gitCommit(worktree, input.message)
    } catch (e) {
      if (e instanceof GitError) {
        throw createError({ statusCode: 422, statusMessage: e.message })
      }
      throw e
    }
  },
})
