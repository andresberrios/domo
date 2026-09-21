import { removeProjectCascade } from '../../lib/projects'

export default defineEventHandler(async (event) => {
  await removeProjectCascade(getRouterParam(event, 'id')!)
  return { ok: true }
})
