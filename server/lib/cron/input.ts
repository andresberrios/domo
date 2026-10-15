import { nextCronOccurrence, validateTimezone } from './expression'
import type { CronJob, MessageDelivery } from '../../../shared/types'

const DELIVERIES: MessageDelivery[] = ['steer', 'queue', 'interrupt']

export interface CronJobInput {
  /** The session to wake; or `assistantId`, exactly one of the two. */
  agentSessionId?: string | null
  assistantId?: string | null
  name: string
  prompt: string
  cronExpression?: string | null
  runAt?: string | null
  timezone?: string
  delivery?: MessageDelivery
  enabled?: boolean
  /** Only a paused job can be archived; enabling one unarchives it. */
  archived?: boolean
  createdBy?: CronJob['createdBy']
}

/**
 * Where a change leaves a job's `enabled` and `archived`. Archiving pauses,
 * and resuming unarchives, so an archived job is never one that fires.
 * `archiveOnPause` is for agents: a schedule they stop is put away unless
 * they say to keep it in the list.
 */
export function cronJobState(
  existing: Pick<CronJob, 'enabled' | 'archived'>,
  patch: { enabled?: boolean, archived?: boolean },
  { archiveOnPause = false } = {}
): { enabled: boolean, archived: boolean } {
  if (patch.enabled === true && patch.archived === true) {
    throw new Error('An archived task is paused: pass enabled: true or archived: true, not both.')
  }
  const enabled = patch.archived === true ? false : (patch.enabled ?? existing.enabled)
  if (enabled) return { enabled, archived: false }
  const archived = patch.archived ?? (archiveOnPause && patch.enabled === false ? true : existing.archived)
  return { enabled, archived }
}
export function normalizeCronJobInput(input: CronJobInput, now = new Date()) {
  const name = String(input.name ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  const assistantId = String(input.assistantId ?? '').trim() || null
  const agentSessionId = assistantId ? null : String(input.agentSessionId ?? '').trim() || null
  if (!agentSessionId && !assistantId) throw new Error('agentSessionId or assistantId is required.')
  if (!name) throw new Error('name is required.')
  if (!prompt) throw new Error('prompt is required.')
  if (!!input.cronExpression === !!input.runAt) {
    throw new Error('Provide exactly one of cronExpression or runAt.')
  }
  const delivery = DELIVERIES.find(value => value === input.delivery) ?? 'queue'
  const enabled = input.enabled !== false
  const archived = !enabled && input.archived === true

  if (input.cronExpression) {
    const cronExpression = input.cronExpression.trim()
    const timezone = validateTimezone(input.timezone ?? 'UTC')
    const nextRunAt = enabled ? nextCronOccurrence(cronExpression, timezone, now).toISOString() : null
    return {
      agentSessionId, assistantId, name, prompt, scheduleType: 'cron' as const,
      cronExpression, timezone, runAt: null, enabled, archived, delivery, nextRunAt,
      createdBy: input.createdBy ?? 'user'
    }
  }

  const date = new Date(input.runAt!)
  if (!Number.isFinite(date.getTime())) throw new Error('runAt must be a valid ISO date and time.')
  if (enabled && date.getTime() <= now.getTime()) throw new Error('runAt must be in the future.')
  return {
    agentSessionId, assistantId, name, prompt, scheduleType: 'once' as const,
    cronExpression: null, timezone: 'UTC', runAt: date.toISOString(), enabled, archived, delivery,
    nextRunAt: enabled ? date.toISOString() : null,
    createdBy: input.createdBy ?? 'user'
  }
}
