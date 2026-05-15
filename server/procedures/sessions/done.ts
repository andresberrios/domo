import { z } from 'zod'
import { Session } from '../../lib/schemas'
import { getSession, updateSession } from '../../lib/sessions'

/**
 * Toggle the `done` flag. Purely a left-rail UX classification — it does
 * not delete the durable stream, so a done session can be un-done and
 * continued.
 */
export default defineProcedure({
  input: z.object({ id: z.string(), done: z.boolean() }),
  output: Session,
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    updateSession(session.id, { done: input.done })
    return { ...session, done: input.done }
  },
})
