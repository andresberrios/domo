import { describe, expect, it } from 'vitest'

import { nextCronOccurrence, parseCronExpression, validateTimezone } from '../../server/lib/cron/expression'
import { normalizeCronJobInput } from '../../server/lib/cron/input'

describe('cron expressions', () => {
  it('finds the next matching minute in UTC', () => {
    expect(nextCronOccurrence('*/15 9-10 * * 1-5', 'UTC', new Date('2026-09-21T09:07:41Z')).toISOString())
      .toBe('2026-09-21T09:15:00.000Z')
  })

  it('interprets a schedule in its IANA time zone', () => {
    expect(nextCronOccurrence('0 9 * * *', 'America/New_York', new Date('2026-07-01T12:30:00Z')).toISOString())
      .toBe('2026-07-01T13:00:00.000Z')
  })

  it('accepts names and Sunday as either 0 or 7', () => {
    expect(nextCronOccurrence('0 0 * jan sun', 'UTC', new Date('2027-01-01T00:00:00Z')).toISOString())
      .toBe('2027-01-03T00:00:00.000Z')
    expect(nextCronOccurrence('0 0 * 1 7', 'UTC', new Date('2027-01-01T00:00:00Z')).toISOString())
      .toBe('2027-01-03T00:00:00.000Z')
  })

  it('rejects malformed fields and unknown zones', () => {
    expect(() => parseCronExpression('0 25 * * *')).toThrow('expected 0-23')
    expect(() => parseCronExpression('0 9 * *')).toThrow('five fields')
    expect(() => validateTimezone('Moon/Sea-of-Tranquility')).toThrow('Unknown time zone')
  })

  it('bounds a syntactically valid schedule that can never occur', () => {
    expect(() => nextCronOccurrence('0 0 30 2 *', 'UTC', new Date('2026-01-01T00:00:00Z')))
      .toThrow('no occurrence')
  })
})

describe('scheduled task input', () => {
  const now = new Date('2026-09-21T10:00:00Z')

  it('requires exactly one schedule and materialises the next run', () => {
    const normalized = normalizeCronJobInput({
      agentSessionId: 'ag_1', name: 'Check', prompt: 'Inspect CI', cronExpression: '0 9 * * *'
    }, now)
    expect(normalized).toMatchObject({ scheduleType: 'cron', delivery: 'queue', timezone: 'UTC' })
    expect(normalized.nextRunAt).toBe('2026-09-22T09:00:00.000Z')
    expect(() => normalizeCronJobInput({
      agentSessionId: 'ag_1', name: 'Bad', prompt: 'No', cronExpression: '* * * * *', runAt: '2027-01-01'
    }, now)).toThrow('exactly one')
  })

  it('rejects enabled one-time jobs in the past', () => {
    expect(() => normalizeCronJobInput({
      agentSessionId: 'ag_1', name: 'Late', prompt: 'Run', runAt: '2026-09-20T00:00:00Z'
    }, now)).toThrow('future')
  })
})
