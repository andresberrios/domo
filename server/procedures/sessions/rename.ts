import { z } from 'zod'
import { Session } from '../../lib/schemas'
import { getSession, updateSession } from '../../lib/sessions'

/**
 * Set the user-facing title. The entity auto-tags `title` from the first
 * prompt; this Domo-side value is the editable override the left rail
 * renders (a Domo concept, not pushed back onto the durable stream).
 */
export default defineProcedure({
  input: z.object({ id: z.string(), title: z.string().min(1) }),
  output: Session,
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    updateSession(session.id, { title: input.title })
    return { ...session, title: input.title }
  },
})
