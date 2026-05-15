import { z } from 'zod'
import { GitError, gitPush } from '../../lib/git'
import { resolveEnvWorktree } from '../../lib/workspace'

export default defineProcedure({
  input: z.object({ envId: z.string() }),
  output: z.object({ output: z.string() }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)
    try {
      return await gitPush(worktree)
    } catch (e) {
      if (e instanceof GitError) {
        // No upstream / rejected / auth — surface git's own message.
        throw createError({ statusCode: 422, statusMessage: e.message })
      }
      throw e
    }
  },
})
