import { z } from 'zod'

import { requireActiveUser } from '../../lib/auth'
import { getSession } from '../../lib/sessions'
import { sessionEngine } from '../../lib/sessionEngine/engine'

/**
 * Send a user message to the session, *triggering* a turn.
 *
 * If a turn is live this becomes a **steer** (mid-turn
 * `--replay-user-messages` injection); else it's a fresh turn
 * (spawn-or-reuse the long-lived process). The engine appends a
 * durable `prompt` event carrying author info so group-chat
 * transcripts show who sent what; slash / `@` expansion happens at
 * execution time, not here.
 *
 * Any un-consumed `chat`-event backlog (from `sessions.chat` calls
 * since the last triggered turn) is folded into the synthesized
 * prompt body — Decided #13 group-chat collab.
 */
export default defineProcedure({
  input: z.object({ id: z.string(), text: z.string().min(1) }),
  output: z.object({
    ok: z.literal(true),
    steered: z.boolean(),
    uuid: z.string().optional(),
  }),
  handler: async ({ input, event }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    const user = await requireActiveUser(event)
    const r = sessionEngine.prompt(session.id, input.text, {
      userId: user.id,
      userName: user.name,
    })
    return {
      ok: true as const,
      steered: r.steered,
      ...(r.uuid ? { uuid: r.uuid } : {}),
    }
  },
})
