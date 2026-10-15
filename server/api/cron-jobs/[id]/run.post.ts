import { runCronJobNow } from '../../../lib/cron/scheduler'
import { getCronJob } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const job = await getCronJob(id)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Scheduled task not found' })
  try {
    return await runCronJobNow(job)
  } catch (error) {
    // The failure is on the run, in the job's history, as well.
    throw createError({ statusCode: 409, statusMessage: error instanceof Error ? error.message : String(error) })
  }
})
