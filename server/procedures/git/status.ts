import { z } from 'zod'
import { GitError, gitStatus } from '../../lib/git'
import { resolveEnvWorktree } from '../../lib/workspace'

const Entry = z.object({
  path: z.string(),
  origPath: z.string().optional(),
  index: z.string(),
  worktree: z.string(),
})

/**
 * VS Code-style status for the Git changes pane: branch + ahead/behind and
 * staged / unstaged / untracked file lists. Runs against the worktree on
 * the host (the worktree is a host-side dir).
 */
export default defineProcedure({
  input: z.object({ envId: z.string() }),
  output: z.object({
    branch: z.string().nullable(),
    upstream: z.string().nullable(),
    ahead: z.number().int(),
    behind: z.number().int(),
    staged: z.array(Entry),
    unstaged: z.array(Entry),
    untracked: z.array(Entry),
  }),
  handler: async ({ input }) => {
    const { worktree } = await resolveEnvWorktree(input.envId)
    try {
      return await gitStatus(worktree)
    } catch (e) {
      if (e instanceof GitError) {
        throw createError({ statusCode: 422, statusMessage: e.message })
      }
      throw e
    }
  },
})
