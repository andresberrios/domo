import { z } from 'zod'
import { getSession, updateSession } from '../../lib/sessions'
import { ensureRuntimeReady } from '../../lib/electric/client'

/**
 * Push a user turn into the session's inbox. The pull-wake runtime claims
 * the wake and runs `claude` for one turn (host-side stream-json), mirror-
 * ing envelopes into the durable stream. `status` is bumped optimistically
 * for fast left-rail feedback; the stream is authoritative.
 */
export default defineProcedure({
  input: z.object({ id: z.string(), text: z.string().min(1) }),
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
    // Raw text only — the entity expands custom slash commands +
    // @-mentions at execution time, so the durable inbox / transcript
    // keeps exactly what the user typed.
    const client = await ensureRuntimeReady()
    await client.sendEntityMessage({
      targetUrl: session.entityId,
      type: 'prompt',
      payload: { text: input.text },
    })
    updateSession(session.id, { status: 'active', lastEventAt: Date.now() })
    return { ok: true as const }
  },
})
