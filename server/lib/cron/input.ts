import { nextCronOccurrence, validateTimezone } from './expression'
import type { CronJob, MessageDelivery } from '../../../shared/types'

const DELIVERIES: MessageDelivery[] = ['steer', 'queue', 'interrupt']

export interface CronJobInput {
  agentSessionId: string
  name: string
  prompt: string
  cronExpression?: string | null
  runAt?: string | null
  timezone?: string
  delivery?: MessageDelivery
  enabled?: boolean
  createdBy?: CronJob['createdBy']
}
export function normalizeCronJobInput(input: CronJobInput, now = new Date()) {
  const name = String(input.name ?? '').trim()
  const prompt = String(input.prompt ?? '').trim()
  const agentSessionId = String(input.agentSessionId ?? '').trim()
  if (!agentSessionId) throw new Error('agentSessionId is required.')
  if (!name) throw new Error('name is required.')
  if (!prompt) throw new Error('prompt is required.')
  if (!!input.cronExpression === !!input.runAt) {
    throw new Error('Provide exactly one of cronExpression or runAt.')
  }
  const delivery = DELIVERIES.find(value => value === input.delivery) ?? 'queue'
  const enabled = input.enabled !== false

  if (input.cronExpression) {
    const cronExpression = input.cronExpression.trim()
    const timezone = validateTimezone(input.timezone ?? 'UTC')
    const nextRunAt = enabled ? nextCronOccurrence(cronExpression, timezone, now).toISOString() : null
    return {
      agentSessionId, name, prompt, scheduleType: 'cron' as const,
      cronExpression, timezone, runAt: null, enabled, delivery, nextRunAt,
      createdBy: input.createdBy ?? 'user'
    }
  }

  const date = new Date(input.runAt!)
  if (!Number.isFinite(date.getTime())) throw new Error('runAt must be a valid ISO date and time.')
  if (enabled && date.getTime() <= now.getTime()) throw new Error('runAt must be in the future.')
  return {
    agentSessionId, name, prompt, scheduleType: 'once' as const,
    cronExpression: null, timezone: 'UTC', runAt: date.toISOString(), enabled, delivery,
    nextRunAt: enabled ? date.toISOString() : null,
    createdBy: input.createdBy ?? 'user'
  }
}
