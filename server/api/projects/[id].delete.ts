import { removeEnvironment } from '../../lib/dev-environments'
import { acpManager } from '../../lib/acp/manager'
import { deleteAgentSession, deleteProject, listAgentSessions, listDevEnvironments } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const environments = await listDevEnvironments(id)
  const agents = await listAgentSessions(true)
  for (const environment of environments) {
    for (const agent of agents.filter(item => item.devEnvironmentId === environment.id)) {
      acpManager.stop(agent.id)
      await deleteAgentSession(agent.id)
    }
    await removeEnvironment(environment.id)
  }
  await deleteProject(id)
  return { ok: true }
})
