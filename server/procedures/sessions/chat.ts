import { z } from 'zod'

import { requireActiveUser } from '../../lib/auth'
import { getSession } from '../../lib/sessions'
import { sessionEngine } from '../../lib/sessionEngine/engine'

/**
 * Append a `chat` event to a session without (by default) triggering a
 * turn — the step 5 group-collab path. Multiple humans on the same
 * session can converse; the agent stays silent until somebody
 * `@agent`s or sends via `sessions.prompt` (or `trigger: true` here).
 * When a turn IS triggered, the engine folds every un-consumed chat
 * (including the one just recorded) into the synthesized prompt.
 *
 * Identity is taken from `requireActiveUser` — clients can't author as
 * someone else.
 */
export default defineProcedure({
  input: z.object({
    id: z.string(),
    text: z.string().min(1),
    /** Force-trigger a turn even if the text has no `@agent`. The
     * "Send to agent ▶" button sets this; default is "chat only". */
    trigger: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.literal(true),
    triggered: z.boolean(),
  }),
  handler: async ({ input, event }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    const user = await requireActiveUser(event)
    const r = sessionEngine.chat(
      session.id,
      input.text,
      { userId: user.id, userName: user.name },
      { trigger: input.trigger ?? false },
    )
    return { ok: true as const, triggered: r.triggered }
  },
})
