import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { resolveEnvWorktree } from '../../lib/workspace'
import { searchMentions } from '../../lib/mentions'

/**
 * `@`-mention candidates for a session's env worktree (files/folders,
 * `@git-changes`, recent commits) filtered by `query`, for the chat
 * input's `@` popup. Empty list if the worktree isn't provisioned yet.
 */
export default defineProcedure({
  input: z.object({
    id: z.string(),
    query: z.string().default(''),
  }),
  output: z.array(
    z.object({
      kind: z.enum(['file', 'folder', 'git', 'commit']),
      value: z.string(),
      label: z.string(),
      description: z.string().optional(),
    }),
  ),
  handler: async ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    try {
      const { worktree } = await resolveEnvWorktree(session.envId)
      return await searchMentions(worktree, input.query)
    } catch {
      return []
    }
  },
})
