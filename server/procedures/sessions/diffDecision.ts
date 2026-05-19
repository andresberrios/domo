import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { sessionEngine } from '../../lib/sessionEngine/engine'

/**
 * Resolve a parked agent edit by `callId`. Two paths:
 *
 * **In-process (the common path):** the parking turn is alive — the
 * engine resolves the parked promise, the running CLI applies the edit
 * itself (on `accept`) and we record `diff_decision` durably. No
 * round-trip, no deadlock.
 *
 * **Post-restart:** the parking turn died. Engine reports `inProcess:false`;
 * it still flips the durable `pending_diffs` row + records a
 * `diff_decision { reason:'post-restart' }` so the chat card clears.
 * The next prompt resumes via `claude --resume`; if the user accepted,
 * the agent may re-propose a fresh, actionable diff (we deliberately do
 * NOT replay-apply the dead turn's edit — it would race the re-proposal
 * and double-write).
 */
export default defineProcedure({
  input: z.object({
    id: z.string(),
    callId: z.string(),
    decision: z.enum(['accept', 'reject']),
  }),
  output: z.object({ ok: z.literal(true), inProcess: z.boolean() }),
  handler: ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    const { inProcess } = sessionEngine.diffDecision(
      session.id,
      input.callId,
      input.decision,
    )
    return { ok: true as const, inProcess }
  },
})
