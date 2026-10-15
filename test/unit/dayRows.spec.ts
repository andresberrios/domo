import { describe, expect, it } from 'vitest'

import { withDayRows, type CondensedItem, type DayRow } from '~/utils/agentTranscript'

const note = (id: string, at: string): CondensedItem => ({ id, seq: 0, at, kind: 'notice', tone: 'info', text: id })
const local = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()

describe('withDayRows', () => {
  it('opens each day with a line of its own, before the first row of that day', () => {
    const rows = withDayRows([note('a', local(13, 9)), note('b', local(13, 18)), note('c', local(14, 8))])

    expect(rows.map(row => row.kind === 'day' ? `day:${row.at}` : row.id)).toEqual([
      `day:${local(13, 9)}`, 'a', 'b', `day:${local(14, 8)}`, 'c'
    ])
  })

  /**
   * The page above arrives later. When it ends on the same day the first
   * loaded row began, that day's line moves up to the new first row of the
   * day — by its key, so the list moves it rather than drawing a new one, and
   * the row that had it keeps its height.
   */
  it('moves a day\'s line up when the rows above continue the same day, under the same key', () => {
    const seen = new Map<string, DayRow>()
    const first = withDayRows([note('b', local(13, 18))], seen)
    const later = withDayRows([note('a', local(13, 9)), note('b', local(13, 18))], seen)

    expect(first[0]!.id).toBe(later[0]!.id)
    expect(later.map(row => row.id)).toEqual([first[0]!.id, 'a', 'b'])
    expect(later.filter(row => row.kind === 'day')).toHaveLength(1)
  })

  it('hands back the same line when it has not moved', () => {
    const seen = new Map<string, DayRow>()
    const items = [note('a', local(13, 9))]

    expect(withDayRows(items, seen)[0]).toBe(withDayRows(items, seen)[0])
  })
})
