import { describe, expect, it } from 'vitest'

import { currentUsageLimit, usageLimitLabel, usageResetPassed } from '~~/shared/usage-limits'
import type { UsageLimit } from '~~/shared/types'

/**
 * How a stored row reads now: today's label, and a window that has reset since
 * it was read shown as reset rather than at its old number.
 */

const NOW = Date.parse('2026-10-21T21:00:00.000Z')

function row(patch: Partial<UsageLimit> = {}): UsageLimit {
  return {
    provider: 'claude',
    limitId: 'five_hour',
    label: '5-hour limit',
    usedPercent: 99,
    resetsAt: '2026-10-21T20:50:00.000Z',
    windowMinutes: 300,
    status: 'allowed_warning',
    amountUsed: null,
    amountLimit: null,
    currency: null,
    source: 'session-event',
    updatedAt: '2026-10-21T16:00:00.000Z',
    ...patch
  }
}

describe('usageResetPassed', () => {
  it('is true once the reset has passed a reading taken before it', () => {
    expect(usageResetPassed(row(), NOW)).toBe(true)
  })

  it('is false while the reset is still ahead', () => {
    expect(usageResetPassed(row({ resetsAt: '2026-10-21T21:30:00.000Z' }), NOW)).toBe(false)
  })

  it('is false for a reading taken after the reset, which already counts the new window', () => {
    expect(usageResetPassed(row({ updatedAt: '2026-10-21T20:55:00.000Z' }), NOW)).toBe(false)
  })

  it('is false for a row with no window to reset', () => {
    expect(usageResetPassed(row({ resetsAt: null }), NOW)).toBe(false)
    expect(usageResetPassed(row({ usedPercent: null }), NOW)).toBe(false)
  })
})

describe('currentUsageLimit', () => {
  it('shows a window whose reset has passed as reset, with no reset time and no refusal', () => {
    const current = currentUsageLimit(row({ status: 'rejected' }), NOW)
    expect(current).toMatchObject({ usedPercent: 0, resetsAt: null, status: 'allowed', resetPassed: true })
  })

  it('leaves a current reading as it is', () => {
    const current = currentUsageLimit(row({ resetsAt: '2026-10-21T23:00:00.000Z' }), NOW)
    expect(current).toMatchObject({ usedPercent: 99, status: 'allowed_warning', resetPassed: false })
  })
})

describe('usageLimitLabel', () => {
  it('labels a Claude row from today\'s names, whatever an older Domo stored', () => {
    expect(usageLimitLabel(row({ limitId: 'seven_day_overage_included', label: 'Weekly · extra usage included' })))
      .toBe('Weekly · Fable')
    expect(usageLimitLabel(row({ limitId: 'extra_usage', label: 'Usage credits' }))).toBe('Extra usage')
    expect(usageLimitLabel(row({ limitId: 'model:Opus', label: '' }))).toBe('Weekly · Opus')
  })

  it('keeps the stored label of a provider whose rows are named by their source', () => {
    expect(usageLimitLabel(row({ provider: 'codex', limitId: 'plan:primary', label: 'GPT-5 · 5h limit' })))
      .toBe('GPT-5 · 5h limit')
  })
})
