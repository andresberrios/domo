import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { sessionEngine } from '../../lib/sessionEngine/engine'

/**
 * Request the in-flight turn stop. The engine SIGTERMs the long-lived
 * `claude` child (settling any parked diff as rejected) and records a
 * durable `aborted` event; next prompt respawns with
 * `claude --resume <nativeId>`. With no live turn this still un-sticks a
 * stale cached `active`/`pending-approval` status from a prior crash.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.literal(true), aborted: z.boolean() }),
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    const aborted = sessionEngine.abort(session.id)
    return { ok: true as const, aborted }
  },
})
