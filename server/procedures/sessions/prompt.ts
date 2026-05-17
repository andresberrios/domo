import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { getSession, updateSession } from '../../lib/sessions'
import { ensureRuntimeReady } from '../../lib/electric/client'
import { steerSession } from '../../lib/electric/sessionControl'

/**
 * Send a user message to the session.
 *
 * If a turn is **live** in this process, it's a *steer* (Decided #18):
 * inject it into the running `claude`'s stdin in-process — the CLI queues
 * it and consumes it at the next step boundary while the turn continues.
 * The live handler records a durable `steer_sent` event; the CLI's
 * `isReplay` echo (mirrored to the stream) is matched by `uuid` to flip
 * the transcript bubble queued→delivered. (Same in-process channel
 * diff-decisions use — the single-flight pull-wake runner can't deliver a
 * wake mid-turn.)
 *
 * Otherwise it's a fresh turn: push a `prompt` inbox message; the
 * pull-wake runtime claims the wake and runs one `claude` turn. Raw text
 * only — the entity expands slash/@-mentions at execution time so the
 * transcript keeps exactly what the user typed. (Steered text is *not*
 * expanded in v1 — steering is normally plain English; keeps the
 * raw-text invariant trivial.)
 */
export default defineProcedure({
  input: z.object({ id: z.string(), text: z.string().min(1) }),
  output: z.object({
    ok: z.literal(true),
    steered: z.boolean(),
    uuid: z.string().optional(),
  }),
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

    const uuid = randomUUID()
    if (steerSession(session.id, input.text, uuid)) {
      updateSession(session.id, { lastEventAt: Date.now() })
      return { ok: true as const, steered: true, uuid }
    }

    const client = await ensureRuntimeReady()
    await client.sendEntityMessage({
      targetUrl: session.entityId,
      type: 'prompt',
      payload: { text: input.text },
    })
    updateSession(session.id, { status: 'active', lastEventAt: Date.now() })
    return { ok: true as const, steered: false }
  },
})
