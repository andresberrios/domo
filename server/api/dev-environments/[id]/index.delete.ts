import { removeProjectEnvironment } from '../../../lib/projects'

export default defineEventHandler(async (event) => {
  await removeProjectEnvironment(getRouterParam(event, 'id')!)
  return { ok: true }
})
