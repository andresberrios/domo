import { describe, expect, it } from 'vitest'

import { cronInWords, runNowOutcome, scheduleInWords, timeUntil } from '../../app/utils/schedule'

const at = (hour: number, minute: number) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, hour, minute))

describe('a cron expression in words', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['5 * * * *', 'Every hour at :05'],
    ['0 */6 * * *', 'Every 6 hours at :00'],
    ['30 9 * * *', `Every day at ${at(9, 30)}`],
    ['0 9 * * 1-5', `Weekdays at ${at(9, 0)}`],
    ['0 10 * * 0,6', `Weekends at ${at(10, 0)}`],
    ['0 9 * * 1,5', `Mondays and Fridays at ${at(9, 0)}`],
    ['0 9 * * 7', `Sundays at ${at(9, 0)}`],
    ['0 9,17 * * *', `Every day at ${at(9, 0)} and ${at(17, 0)}`],
    ['0 8 1 * *', `Monthly on the 1st at ${at(8, 0)}`],
    ['0 8 22 * *', `Monthly on the 22nd at ${at(8, 0)}`]
  ])('%s', (expression, words) => {
    expect(cronInWords(expression)).toBe(words)
  })

  it('shows what it cannot put into words as it was written', () => {
    for (const expression of ['0 9 * 1 *', '*/5 9-17 * * 1-5', '0 9 1 * 1', 'nonsense']) {
      expect(cronInWords(expression)).toBe(expression)
    }
  })

  it('names the zone only when it is not the viewer\'s', () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone
    const other = local === 'Asia/Tokyo' ? 'Europe/Amsterdam' : 'Asia/Tokyo'
    const job = { scheduleType: 'cron' as const, cronExpression: '* * * * *', runAt: null }
    expect(scheduleInWords({ ...job, timezone: local })).toBe('Every minute')
    expect(scheduleInWords({ ...job, timezone: other })).toBe(`Every minute (${other})`)
  })
})

describe('time until', () => {
  const now = Date.parse('2026-10-15T12:00:00Z')
  it.each([
    ['2026-10-15T12:00:20Z', 'any moment'],
    ['2026-10-15T12:05:00Z', 'in 5m'],
    ['2026-10-15T15:00:00Z', 'in 3h'],
    ['2026-10-17T12:00:00Z', 'in 2d']
  ])('%s', (value, words) => {
    expect(timeUntil(value, now)).toBe(words)
  })
})

describe('what a run now did', () => {
  it('tells delivered, joined and queued apart', () => {
    expect(runNowOutcome({ outcome: 'prompted' })).toMatch(/^Delivered/)
    expect(runNowOutcome({ outcome: 'steered' })).toContain('running turn')
    expect(runNowOutcome({ outcome: 'queued' })).toMatch(/^Queued/)
  })
})
