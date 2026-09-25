import { retireProjectEnvironment } from '../../../lib/projects'

/**
 * Retire an environment: its container, workspace volume and image are
 * destroyed and every row is kept — the environment's own and the transcript of
 * each agent that ran in it. Those agents can never be started again, which is
 * derived from this row rather than written on them.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const retirement = await retireProjectEnvironment(id)
  return {
    ok: true,
    id,
    retired: true,
    sessionsStoodDown: retirement.sessions.map(session => ({ id: session.id, title: session.title })),
    cronJobsDisabled: retirement.cronJobsDisabled,
    subscriptionsRemoved: retirement.subscriptionsRemoved,
    permissionsCancelled: retirement.permissionsCancelled,
    leftovers: retirement.leftovers
  }
})
