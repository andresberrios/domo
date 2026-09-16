import { listPermissions } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { all } = getQuery(event)
  return listPermissions(id, all !== 'true')
})
