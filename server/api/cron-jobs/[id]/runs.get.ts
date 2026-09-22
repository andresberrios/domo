import { getCronJob, listCronRuns } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  if (!await getCronJob(id)) throw createError({ statusCode: 404, statusMessage: 'Scheduled job not found' })
  return listCronRuns(id)
})
