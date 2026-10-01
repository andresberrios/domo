import { requestHandoff } from '../../../lib/assistants'

/**
 * Ask the assistant's current session to write its handoff note and carry on
 * in a fresh one. Queued behind a turn that is running.
 */
export default defineEventHandler(async (event) => {
  return requestHandoff(getRouterParam(event, 'id')!, 'user')
})
