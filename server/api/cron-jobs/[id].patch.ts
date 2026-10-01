import { normalizeCronJobInput } from '../../lib/cron/input'
import { getAgentSession, getAssistant, getCronJob, replaceCronJob } from '../../lib/repo'
import type { CronJobInput } from '../../lib/cron/input'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const existing = await getCronJob(id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Scheduled job not found' })
  const patch = await readBody<Partial<CronJobInput>>(event)
  try {
    const switchesToCron = patch.cronExpression !== undefined
    const switchesToOnce = patch.runAt !== undefined
    if (switchesToCron && switchesToOnce) {
      throw new Error('Provide only one of cronExpression or runAt.')
    }
    // Naming one target replaces the other.
    const retargets = patch.agentSessionId !== undefined || patch.assistantId !== undefined
    const input = normalizeCronJobInput({
      agentSessionId: retargets ? patch.agentSessionId : existing.agentSessionId,
      assistantId: retargets ? patch.assistantId : existing.assistantId,
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      cronExpression: switchesToOnce ? null : (patch.cronExpression ?? existing.cronExpression),
      runAt: switchesToCron ? null : (patch.runAt ?? existing.runAt),
      timezone: patch.timezone ?? existing.timezone,
      delivery: patch.delivery ?? existing.delivery,
      enabled: patch.enabled ?? existing.enabled,
      createdBy: existing.createdBy
    })
    if (input.assistantId ? !await getAssistant(input.assistantId) : !await getAgentSession(input.agentSessionId!)) {
      throw createError({ statusCode: 404, statusMessage: input.assistantId ? 'Assistant not found' : 'Agent session not found' })
    }
    return replaceCronJob(id, input)
  } catch (error) {
    if ((error as any)?.statusCode) throw error
    throw createError({
      statusCode: 400,
      statusMessage: error instanceof Error ? error.message : String(error)
    })
  }
})
