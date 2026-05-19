import { z } from 'zod'
import { ApprovalMode, Session } from '../../lib/schemas'
import { getEnv } from '../../lib/envs'
import { insertSession, type SessionRow } from '../../lib/sessions'

/**
 * Create a chat session row pointing at an env's worktree. No `claude`
 * process spawns here — `sessions.prompt` is what starts (or steers) one,
 * and is also what auto-titles the session (the first prompt's text is the
 * default title until the user renames it).
 *
 * Post-pivot there is no entity to spawn / dispatch policy to register —
 * the session is just a SQLite row + the in-process engine's keyspace.
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    title: z.string().optional(),
    /** Optional per-session approval policy; omitted → inherit default. */
    approvalMode: ApprovalMode.optional(),
  }),
  output: Session,
  handler: ({ input }) => {
    const env = getEnv(input.envId)
    if (!env) {
      throw createError({ statusCode: 404, statusMessage: 'env not found' })
    }
    if (!env.worktreePath) {
      throw createError({
        statusCode: 409,
        statusMessage: 'env has no worktree yet — provision it first',
      })
    }

    const id = crypto.randomUUID()
    const row: SessionRow = {
      id,
      envId: env.id,
      title: input.title ?? null,
      status: 'waiting',
      done: false,
      nativeClaudeSessionId: null,
      approvalMode: input.approvalMode ?? null,
      createdAt: Date.now(),
      lastEventAt: null,
      viewedAtPerDevice: {},
    }
    insertSession(row)
    return row
  },
})
