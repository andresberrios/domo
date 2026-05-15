import { z } from 'zod'
import { Session } from '../../lib/schemas'
import { listSessions } from '../../lib/sessions'

/**
 * All sessions for an env (done + not-done; the left rail filters with the
 * "show done" toggle). `status` is the cached value — the chat surface
 * reconciles it against the durable stream's `sessionMeta` (Phase 9/10).
 */
export default defineProcedure({
  input: z.object({ envId: z.string() }),
  output: z.array(Session),
  handler: ({ input }) => listSessions(input.envId),
})
