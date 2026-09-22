import { retireProjectCascade } from '../../lib/projects'

/** Retire a project and every environment under it. Nothing is deleted. */
export default defineEventHandler(async (event) => {
  await retireProjectCascade(getRouterParam(event, 'id')!)
  return { ok: true, retired: true }
})
