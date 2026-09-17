import { removeEnvironment } from '../../../lib/dev-environments'
import { acpManager } from '../../../lib/acp/manager'
import { deleteAgentSession, listAgentSessions } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const agents = (await listAgentSessions(true)).filter(agent => agent.devEnvironmentId === id)
  for (const agent of agents) {
    acpManager.stop(agent.id)
    await deleteAgentSession(agent.id)
  }
  await removeEnvironment(id)
  return { ok: true }
})
