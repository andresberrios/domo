import { z } from 'zod'
import { GitError, gitUnstage } from '../../lib/git'
import { resolveEnvWorktree } from '../../lib/workspace'

export default defineProcedure({
  input: z.object({ envId: z.string(), path: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)
    try {
      await gitUnstage(worktree, input.path)
    } catch (e) {
      if (e instanceof GitError) {
        throw createError({ statusCode: 422, statusMessage: e.message })
      }
      throw e
    }
    return { ok: true as const }
  },
})
