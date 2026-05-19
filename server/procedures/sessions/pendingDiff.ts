import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { sessionEngine } from '../../lib/sessionEngine/engine'

/**
 * The before/after for a still-parked agent edit, by `callId` — backs the
 * workspace surface's full-diff view (the chat approval card links here).
 * Reads the live in-process registry first, falling back to the durable
 * `pending_diffs` row (so the link still works across a browser refresh /
 * after a server restart's reconcile pass). `null` once resolved.
 */
export default defineProcedure({
  input: z.object({ id: z.string(), callId: z.string() }),
  output: z
    .object({
      path: z.string(),
      before: z.string(),
      after: z.string(),
      tabName: z.string(),
    })
    .nullable(),
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    return sessionEngine.getPendingDiffMeta(session.id, input.callId)
  },
})
