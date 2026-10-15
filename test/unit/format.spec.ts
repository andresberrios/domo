import { afterEach, describe, expect, it, vi } from 'vitest'

import { clockParts, clockTime, dayKey, dayLabel, fullTime, relativeTime, shortPath, truncate } from '~/utils/format'

describe('relativeTime', () => {
  afterEach(() => vi.useRealTimers())

  function at(now: string) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
  }

  it('is empty for a missing or unparseable value', () => {
    expect(relativeTime(null)).toBe('')
    expect(relativeTime(undefined)).toBe('')
    expect(relativeTime('')).toBe('')
    expect(relativeTime('not a date')).toBe('')
  })

  it('counts up through the units', () => {
    at('2026-01-02T12:00:00.000Z')

    expect(relativeTime('2026-01-02T11:59:40.000Z')).toBe('just now')
    expect(relativeTime('2026-01-02T11:58:50.000Z')).toBe('a minute ago')
    expect(relativeTime('2026-01-02T11:30:00.000Z')).toBe('30m ago')
    expect(relativeTime('2026-01-02T05:00:00.000Z')).toBe('7h ago')
    expect(relativeTime('2025-12-31T12:00:00.000Z')).toBe('2d ago')
  })

  it('falls back to a plain date once a week has passed', () => {
    at('2026-01-20T12:00:00.000Z')

    expect(relativeTime('2026-01-02T12:00:00.000Z')).toBe(new Date('2026-01-02T12:00:00.000Z').toLocaleDateString())
  })
})

describe('shortPath', () => {
  it('keeps a path that is already short enough intact', () => {
    expect(shortPath('srv/app')).toBe('srv/app')
  })

  it('does not count the leading slash as a segment', () => {
    // The ellipsis promises something was dropped; `/srv/app` drops nothing.
    expect(shortPath('/srv/app')).toBe('/srv/app')
    expect(shortPath('/srv')).toBe('/srv')
    expect(shortPath('/')).toBe('/')
  })

  it('elides everything but the last segments', () => {
    expect(shortPath('/Users/me/code/domo/app/utils/format.ts')).toBe('…/utils/format.ts')
    expect(shortPath('/Users/me/code/domo/app/utils/format.ts', 3)).toBe('…/app/utils/format.ts')
  })

  it('ignores a trailing slash, on both sides of the threshold', () => {
    expect(shortPath('/Users/me/code/domo/')).toBe('…/code/domo')
    expect(shortPath('/srv/app/')).toBe('/srv/app')
  })

  it('leaves a backslash path alone — it only knows about /', () => {
    // Domo runs the agents on POSIX hosts; a Windows path is one opaque segment.
    expect(shortPath('C:\\Users\\me\\code\\domo\\app.ts')).toBe('C:\\Users\\me\\code\\domo\\app.ts')
  })

  it('is empty for nothing', () => {
    expect(shortPath(null)).toBe('')
    expect(shortPath('')).toBe('')
  })
})

describe('truncate', () => {
  it('collapses whitespace so a multi-line blob fits on one line', () => {
    expect(truncate('  a\n\n  b \t c  ')).toBe('a b c')
  })

  it('cuts at the limit and marks the cut', () => {
    expect(truncate('x'.repeat(200))).toBe(`${'x'.repeat(140)}…`)
    expect(truncate('abcdef', 3)).toBe('abc…')
  })

  it('leaves a value exactly at the limit alone', () => {
    expect(truncate('abc', 3)).toBe('abc')
  })
})

describe('transcript times', () => {
  // Local wall-clock instants, so the day boundaries hold in any time zone.
  const local = (year: number, month: number, day: number, hour = 12, minute = 0, second = 0) =>
    new Date(year, month - 1, day, hour, minute, second).toISOString()
  const today = dayKey(new Date(2026, 9, 14, 9))

  it('names today and yesterday, and dates the rest', () => {
    expect(dayLabel(local(2026, 10, 14, 0, 1), today)).toBe('Today')
    expect(dayLabel(local(2026, 10, 13, 23, 59), today)).toBe('Yesterday')
    expect(dayLabel(local(2026, 10, 12), today)).not.toMatch(/Today|Yesterday|2026/)
    expect(dayLabel(local(2025, 12, 31), today)).toContain('2025')
  })

  it('knows yesterday across the start of a month', () => {
    expect(dayLabel(local(2026, 9, 30), dayKey(new Date(2026, 9, 1, 9)))).toBe('Yesterday')
  })

  it('puts two instants of one local day on one key, and midnight on the next', () => {
    expect(dayKey(local(2026, 10, 14, 0, 0))).toBe(dayKey(local(2026, 10, 14, 23, 59)))
    expect(dayKey(local(2026, 10, 14, 23, 59))).not.toBe(dayKey(local(2026, 10, 15, 0, 0)))
  })

  it('gives a clock time, and the whole instant for a tooltip', () => {
    expect(clockTime(local(2026, 10, 14, 14, 5, 9))).toMatch(/(14|2):05:09/)
    expect(fullTime(local(2026, 10, 14, 14, 5))).toMatch(/2026/)
  })

  it('splits a clock time into the time and its day period, for a narrow column', () => {
    const { time, period } = clockParts(local(2026, 10, 14, 14, 5, 9))
    expect(time).toMatch(/^(14|2):05:09$/)
    expect(`${time} ${period}`.trim()).toBe(clockTime(local(2026, 10, 14, 14, 5, 9)).replace(/\s+/g, ' '))
    expect(clockParts(null)).toEqual({ time: '', period: '' })
  })

  it('is empty rather than "Invalid Date"', () => {
    expect(clockTime(null)).toBe('')
    expect(clockTime('nope')).toBe('')
    expect(fullTime(undefined)).toBe('')
  })
})
