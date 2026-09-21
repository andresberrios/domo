import { listInboxMessages } from '../../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const pendingOnly = getQuery(event).all !== 'true'
  return listInboxMessages(id, pendingOnly)
})
