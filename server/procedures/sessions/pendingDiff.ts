import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { getParkedDiff } from '../../lib/electric/sessionControl'

/**
 * The before/after for a still-parked agent edit, by `callId` — backs the
 * workspace surface's full-diff view (the chat approval card links here).
 * Served from the in-process park registry (the runtime is in-process), so
 * no server-side durable-stream read. `null` once resolved / if the
 * runtime restarted — the browser still has it via the durable
 * `pendingDiffs` collection for the inline card.
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
    return getParkedDiff(input.id, input.callId)
  },
})
