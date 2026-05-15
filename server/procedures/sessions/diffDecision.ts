import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { ensureRuntimeReady } from '../../lib/electric/client'

/**
 * Resolve a parked IDE-bridge `openDiff` by `callId`. The full park →
 * `pendingDiffs` → resolve round-trip is step 11; this is the inbox half
 * (the entity records the decision and, once 11 lands, resolves the parked
 * WS call with FILE_SAVED / DIFF_REJECTED).
 */
export default defineProcedure({
  input: z.object({
    id: z.string(),
    callId: z.string(),
    decision: z.enum(['accept', 'reject']),
  }),
  output: z.object({ ok: z.literal(true) }),
  handler: async ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    if (!session.entityId) {
      throw createError({
        statusCode: 409,
        statusMessage: 'session has no entity',
      })
    }
    const client = await ensureRuntimeReady()
    await client.sendEntityMessage({
      targetUrl: session.entityId,
      type: 'diff_decision',
      payload: { callId: input.callId, decision: input.decision },
    })
    return { ok: true as const }
  },
})
