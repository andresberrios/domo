import { acpManager } from '../../../lib/acp/manager'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await acpManager.cancel(id)
  return { ok: true }
})
