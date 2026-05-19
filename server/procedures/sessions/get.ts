import { z } from 'zod'
import { Session } from '../../lib/schemas'
import { getSession } from '../../lib/sessions'

/**
 * Resolve one session row. Throws 404 if it does not exist — consistent
 * with the other `sessions.*` procedures (`rename`, `diffDecision`,
 * `setApprovalMode`, …), so callers get a single error channel instead
 * of also having to special-case a `null` success value.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: Session,
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    return session
  },
})
