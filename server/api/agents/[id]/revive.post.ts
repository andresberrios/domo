import { reviveAgentSession } from '../../../lib/session-retention'

/**
 * Bring a retired session back into service.
 *
 * Refused when the environment it ran in has been deleted: the container, the
 * checkout volume and the adapter's own session storage went with it, so there
 * is nothing to come back to. It does not start the adapter — the session comes
 * back `stopped` and the Start button does the rest, because waking a whole
 * environment is a separate decision.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const session = await reviveAgentSession(id)
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  return session
})
