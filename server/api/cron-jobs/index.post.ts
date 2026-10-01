import { normalizeCronJobInput } from '../../lib/cron/input'
import { createCronJob, getAgentSession, getAssistant } from '../../lib/repo'
import type { CronJobInput } from '../../lib/cron/input'

export default defineEventHandler(async (event) => {
  const body = await readBody<CronJobInput>(event)
  try {
    const input = normalizeCronJobInput({ ...body, createdBy: 'user' })
    if (input.assistantId ? !await getAssistant(input.assistantId) : !await getAgentSession(input.agentSessionId!)) {
      throw createError({ statusCode: 404, statusMessage: input.assistantId ? 'Assistant not found' : 'Agent session not found' })
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
