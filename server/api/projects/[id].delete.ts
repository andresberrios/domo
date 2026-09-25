import { retireProjectCascade } from '../../lib/projects'

/** Retire a project and every environment under it. Nothing is deleted. */
export default defineEventHandler(async (event) => {
  const { leftovers } = await retireProjectCascade(getRouterParam(event, 'id')!)
  // Empty unless Docker refused something. It is reported rather than swallowed:
  // a retirement that quietly leaves a checkout on the disk is what this is for.
  return { ok: true, retired: true, leftovers }
})
