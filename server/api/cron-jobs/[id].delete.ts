import { deleteCronJob, getCronJob } from '../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  if (!await getCronJob(id)) throw createError({ statusCode: 404, statusMessage: 'Scheduled task not found' })
  await deleteCronJob(id)
  return { ok: true }
})
