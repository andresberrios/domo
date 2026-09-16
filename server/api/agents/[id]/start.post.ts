import { acpManager } from '../../../lib/acp/manager'
import { getAgentSession } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  await acpManager.start(id)
  return getAgentSession(id)
})
