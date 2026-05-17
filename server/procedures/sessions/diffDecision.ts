import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { resolveDiff } from '../../lib/electric/sessionControl'
import { ensureRuntimeReady } from '../../lib/electric/client'

/**
 * Resolve a parked IDE-bridge `openDiff` by `callId` (step 11).
 *
 * **Fast path:** the decision is delivered in-process — the pull-wake
 * runner is single-flight per entity, so a `diff_decision` *wake* would
 * never be claimed while the `prompt` turn is blocked inside `openDiff`
 * (deadlock). The runtime is in-process, so we resolve the parked promise
 * directly; the still-running turn writes the file (on accept) and records
 * the outcome durably (pendingDiffs status + `diff_decision` event).
 *
 * **Durable fallback:** if nothing is parked here (`found:false`) the
 * decision is for a session whose runtime had restarted — the durable
 * `pendingDiffs` row (replayed from the stream cross-device / post-restart)
 * is still `pending`. We send the durable `diff_decision` inbox; the
 * entity's handler picks it up on a fresh wake (no blocked turn now, so no
 * deadlock), applies the accepted edit to disk from the durable row, and
 * records it. The conversation then continues on the next prompt via
 * `--resume`. This is what makes a diff reviewable & actionable after
 * closing the client or restarting the server.
 */
export default defineProcedure({
  input: z.object({
    id: z.string(),
    callId: z.string(),
    decision: z.enum(['accept', 'reject']),
  }),
  output: z.object({ ok: z.literal(true), inProcess: z.boolean() }),
  handler: async ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    const inProcess = resolveDiff(
      input.id,
      input.callId,
      input.decision === 'accept',
    )
    if (!inProcess && session.entityId) {
      const client = await ensureRuntimeReady()
      await client.sendEntityMessage({
        targetUrl: session.entityId,
        type: 'diff_decision',
        payload: { callId: input.callId, decision: input.decision },
      })
    }
    return { ok: true as const, inProcess }
  },
})
