import { z } from 'zod'
import { deleteSession, getSession } from '../../lib/sessions'
import { sessionEngine } from '../../lib/sessionEngine/engine'

/**
 * Remove the session. SIGTERMs any live `claude` child first (the engine's
 * abort is a no-op if nothing is running); the `session_events` rows + the
 * `pending_diffs` rows are removed by the `ON DELETE CASCADE` on the
 * `sessions` row.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) return { deleted: false }
    sessionEngine.abort(session.id)
    deleteSession(session.id)
    return { deleted: true }
  },
})
