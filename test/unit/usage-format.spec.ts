import { describe, expect, it } from 'vitest'

import {
  formatAmount,
  formatPercent,
  formatReset,
  formatStaleness,
  formatTokens,
  limitLabel,
  percentOf,
  usageTone,
  worstLimit
} from '../../app/utils/usage'
import type { UsageLimit } from '~~/shared/types'

/**
 * The formatters every usage surface renders through.
 *
 * Each of them is a place where the obvious implementation is subtly wrong, so
 * each case below is a thing that was wrong or would have been.
 */

const NOW = Date.parse('2026-09-21T12:00:00.000Z')

function limit(patch: Partial<UsageLimit> = {}): UsageLimit {
  return {
    provider: 'claude',
    limitId: 'five_hour',
    label: '5-hour limit',
    usedPercent: 10,
    resetsAt: null,
    windowMinutes: 300,
    status: null,
    amountUsed: null,
    amountLimit: null,
    currency: null,
    source: 'endpoint',
    updatedAt: '2026-09-21T12:00:00.000Z',
    ...patch
  }
}

describe('formatTokens', () => {
  it('matches the compact form the panel this is modelled on uses', () => {
    expect(formatTokens(189_200)).toBe('189.2k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(847)).toBe('847')
  })

  it('drops a trailing .0, which carries nothing', () => {
    // "1.0M" reads as a measurement; "1M" reads as a number.
    expect(formatTokens(131_072)).toBe('131.1k')
    expect(formatTokens(1_048_576)).toBe('1M')
    expect(formatTokens(12_500_000)).toBe('12.5M')
  })

  it('never invents a number for one it was not given', () => {
    expect(formatTokens(Number.NaN)).toBe('—')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('percentOf', () => {
  it('is null without a window, so the UI shows tokens rather than a made-up share', () => {
    expect(percentOf(1000, null)).toBeNull()
    expect(percentOf(1000, 0)).toBeNull()
  })

  it('rounds to a whole percent, so the bar and the label agree', () => {
    expect(percentOf(189_200, 1_000_000)).toBe(19)
  })
})

describe('formatPercent', () => {
  it('is an em dash for a window nobody has reported, not 0%', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0)).toBe('0%')
  })
})

describe('formatAmount', () => {
  it('renders a currency as money', () => {
    expect(formatAmount(15.95, 'USD')).toContain('15.95')
    expect(formatAmount(100, 'USD')).toContain('100')
  })

  it('renders credits in their own units, since they are not money', () => {
    expect(formatAmount(1250, 'credits')).toBe('1,250 credits')
  })

  it('survives a currency code Intl does not know rather than throwing', () => {
    expect(formatAmount(12.5, 'NOTACURRENCY')).toBe('12.50 NOTACURRENCY')
  })
})

describe('formatReset', () => {
  it('counts down while a countdown is useful', () => {
    expect(formatReset('2026-09-21T15:41:00.000Z', NOW)).toBe('Resets in 3 hr 41 min')
    expect(formatReset('2026-09-21T12:20:00.000Z', NOW)).toBe('Resets in 20 min')
    expect(formatReset('2026-09-21T15:00:00.000Z', NOW)).toBe('Resets in 3 hr')
  })

  it('switches to a weekday past a day, which is easier to picture', () => {
    expect(formatReset('2026-09-25T23:00:00.000Z', NOW)).toMatch(/^Resets \w{3}/)
  })

  it('says so rather than counting backwards when the reset has passed', () => {
    // The readings lag the clock — Claude's endpoint answers about once an hour
    // — so a window can be past its reset with the row not yet refreshed.
    expect(formatReset('2026-09-21T11:00:00.000Z', NOW)).toBe('Resetting now')
  })

  it('is empty for a window with no reset and for an unparseable one', () => {
    expect(formatReset(null, NOW)).toBe('')
    expect(formatReset('not a date', NOW)).toBe('')
  })
})

describe('formatStaleness', () => {
  it('says nothing while the reading is current', () => {
    expect(formatStaleness('2026-09-21T11:59:30.000Z', NOW)).toBe('')
  })

  it('says how old the reading is once it matters', () => {
    expect(formatStaleness('2026-09-21T11:48:00.000Z', NOW)).toBe('as of 12 min ago')
    expect(formatStaleness('2026-09-21T09:00:00.000Z', NOW)).toBe('as of 3 hr ago')
    expect(formatStaleness('2026-09-19T12:00:00.000Z', NOW)).toBe('as of 2 d ago')
  })
})

describe('usageTone', () => {
  it('is neutral, warning at 70 and error at 90', () => {
    expect(usageTone(10)).toBe('primary')
    expect(usageTone(69)).toBe('primary')
    expect(usageTone(70)).toBe('warning')
    expect(usageTone(89)).toBe('warning')
    expect(usageTone(90)).toBe('error')
  })

  it('follows the consequence, not the number, when a window is refusing work', () => {
    // A window can reject below 100% utilization; the colour has to say so.
    expect(usageTone(12, 'rejected')).toBe('error')
  })

  it('is neutral for a window with no reading, so nothing is implied', () => {
    expect(usageTone(null)).toBe('neutral')
  })
})

describe('limitLabel', () => {
  it('names the windows a row from an older database would not have named', () => {
    expect(limitLabel('five_hour')).toBe('5-hour limit')
    expect(limitLabel('seven_day')).toBe('Weekly · all models')
    expect(limitLabel('something_new')).toBe('something_new')
  })
})

describe('worstLimit', () => {
  it('picks the window that will actually stop work', () => {
    const worst = worstLimit([
      limit({ limitId: 'seven_day', usedPercent: 11 }),
      limit({ limitId: 'five_hour', usedPercent: 94 })
    ])

    expect(worst?.limitId).toBe('five_hour')
  })

  it('ignores windows with no reading rather than treating them as zero', () => {
    expect(worstLimit([limit({ usedPercent: null })])).toBeNull()
  })
})
