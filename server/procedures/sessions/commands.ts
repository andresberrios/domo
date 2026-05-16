import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { resolveEnvWorktree } from '../../lib/workspace'
import {
  BUILTIN_SLASH_COMMANDS,
  listSlashCommands,
} from '../../lib/claudeCommands'

/**
 * Slash commands available for a session's env worktree — builtins ∪
 * scanned custom commands — for the chat input's `/` popup. Resilient: a
 * not-yet-provisioned worktree falls back to just the builtins so the
 * popup still works.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.array(
    z.object({
      command: z.string(),
      description: z.string(),
      source: z.enum(['builtin', 'project', 'user']),
    }),
  ),
  handler: async ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    try {
      const { worktree } = await resolveEnvWorktree(session.envId)
      return await listSlashCommands(worktree)
    } catch {
      return BUILTIN_SLASH_COMMANDS.map((c) => ({
        ...c,
        source: 'builtin' as const,
      }))
    }
  },
})
