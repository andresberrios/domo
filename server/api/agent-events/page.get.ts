import { agentEventsPageFloor } from '../../lib/repo'

/**
 * Where a page of transcript starts: `?sessions=ag_1,ag_2&before=<seq>&size=400`
 * answers `{ floor }`, the `seq` to load from, or null for "the rest of it".
 * Only the boundary — the rows come through Electric like every other row.
 */
export default defineEventHandler(async (event) => {
  const { sessions, before, size } = getQuery(event)
  const ids = String(sessions ?? '').split(',').filter(Boolean)
  const pageSize = Number(size)
  if (!ids.length || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000) {
    throw createError({ statusCode: 400, statusMessage: 'sessions and size are required' })
  }
  const beforeSeq = before === undefined || before === '' ? undefined : Number(before)
  if (beforeSeq !== undefined && !Number.isFinite(beforeSeq)) {
    throw createError({ statusCode: 400, statusMessage: 'before must be a seq' })
  }
  return { floor: await agentEventsPageFloor(ids, { beforeSeq, size: pageSize }) }
})
