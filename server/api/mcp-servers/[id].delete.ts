import { deleteMcpServer } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  await deleteMcpServer(getRouterParam(event, 'id')!)
  return { ok: true }
})
