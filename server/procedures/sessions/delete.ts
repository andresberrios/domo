import { z } from 'zod'
import { deleteSession, getSession } from '../../lib/sessions'
import { deleteEntityBestEffort } from '../../lib/electric/client'

/**
 * Remove the session. The entity is torn down best-effort (an unreachable
 * agents-server must not strand the DB row); the durable stream may be
 * left orphaned, which is acceptable — the Domo row is what `sessions.list`
 * reads.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ deleted: z.boolean() }),
  handler: async ({ input }) => {
    const session = getSession(input.id)
    if (!session) return { deleted: false }
    if (session.entityId) {
      await deleteEntityBestEffort(session.entityId)
    }
    deleteSession(session.id)
    return { deleted: true }
  },
})
