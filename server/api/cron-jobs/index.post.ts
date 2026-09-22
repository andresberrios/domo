import { normalizeCronJobInput } from '../../lib/cron/input'
import { createCronJob, getAgentSession } from '../../lib/repo'
import type { CronJobInput } from '../../lib/cron/input'

export default defineEventHandler(async (event) => {
  const body = await readBody<CronJobInput>(event)
  try {
    const input = normalizeCronJobInput({ ...body, createdBy: 'user' })
    if (!await getAgentSession(input.agentSessionId)) {
      throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
    }
    return createCronJob(input)
  } catch (error) {
    if ((error as any)?.statusCode) throw error
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error)
    })
  }
})
