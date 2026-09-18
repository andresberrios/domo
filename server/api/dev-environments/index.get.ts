import { listDevEnvironments } from '../../lib/repo'

export default defineEventHandler((event) => {
  const { projectId } = getQuery(event)
  return listDevEnvironments(typeof projectId === 'string' ? projectId : undefined)
})
