import { z } from 'zod'
import { getSession, updateSession } from '../../lib/sessions'
import { ensureRuntimeReady } from '../../lib/electric/client'
import { abortSession } from '../../lib/electric/sessionControl'

/**
 * Request the in-flight turn stop. SIGTERMs the `claude` child + settles
 * any parked openDiff as rejected **in-process** (step 11) — the durable
 * inbox can't carry this mid-turn (single-flight runner deadlock, see
 * `lib/electric/sessionControl`). If no turn is running in this process
 * (queued, or runtime restarted) fall back to the durable `abort` inbox
 * so the entity still records it on its next wake.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.literal(true) }),
  handler: async ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    const stopped = abortSession(input.id)
    if (!stopped && session.entityId) {
      const client = await ensureRuntimeReady()
      await client.sendEntityMessage({
        targetUrl: session.entityId,
        type: 'abort',
        payload: {},
      })
    }
    updateSession(session.id, { status: 'waiting' })
    return { ok: true as const }
  },
})
