import { z } from 'zod'
import { getSession, updateSession } from '../../lib/sessions'
import { ensureRuntimeReady } from '../../lib/electric/client'

/**
 * Request the in-flight turn stop. The entity records `aborted` and goes
 * idle; killing the live `claude` child + rejecting any parked openDiff is
 * finished off with steps 8b/11. Status is set back optimistically.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
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
      type: 'abort',
      payload: {},
    })
    updateSession(session.id, { status: 'waiting' })
    return { ok: true as const }
  },
})
