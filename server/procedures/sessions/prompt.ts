import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { sessionEngine } from '../../lib/sessionEngine/engine'

/**
 * Send a user message to the session.
 *
 * Delegates to the in-process engine: if a turn is live this becomes a
 * **steer** (mid-turn `--replay-user-messages` injection — the CLI
 * consumes at the next step boundary while the turn continues); else
 * it's a fresh turn (spawn-or-reuse the long-lived process, write the
 * user message on the open stdin). The engine appends a durable `prompt`
 * event so the transcript reflects exactly what the user typed; slash /
 * `@` expansion happens at execution time, not here.
 */
export default defineProcedure({
  input: z.object({ id: z.string(), text: z.string().min(1) }),
  output: z.object({
    ok: z.literal(true),
    steered: z.boolean(),
    uuid: z.string().optional(),
  }),
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    const r = sessionEngine.prompt(session.id, input.text)
    return {
      ok: true as const,
      steered: r.steered,
      ...(r.uuid ? { uuid: r.uuid } : {}),
    }
  },
})
