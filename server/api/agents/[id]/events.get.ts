import { listAgentEvents } from '../../../lib/repo'

/**
 * The event log from `since` onwards.
 *
 * `since` cannot express everything the log does any more: a block of streaming
 * text is a single row rewritten in place, so a caller polling with a watermark
 * will never see the rest of a message whose row it has already read. The
 * browser does not use this — it reads `agent_events` through Electric, which
 * streams updates as well as inserts.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { since } = getQuery(event)
  return listAgentEvents(id, Number(since) || 0)
})
