import { markNotificationsSeen } from '../../lib/repo'

/** Mark notifications seen: the ids given, or every unseen one when there are none. */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ ids?: string[] }>(event).catch(() => null)
  const ids = Array.isArray(body?.ids) ? body.ids.map(String) : undefined
  return { seen: await markNotificationsSeen(ids) }
})
