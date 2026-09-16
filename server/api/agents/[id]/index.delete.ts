import { acpManager } from '../../../lib/acp/manager'
import { deleteAgentSession } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  acpManager.stop(id)
  await deleteAgentSession(id)
  return { ok: true }
})
