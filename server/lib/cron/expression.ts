/**
 * A small, dependency-free parser for standard five-field cron expressions.
 * Scheduling walks real UTC minutes and projects each one into the requested
 * IANA zone, so daylight-saving gaps and repeated hours behave naturally.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
}
const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
}

interface Field {
  values: Set<number>
  wildcard: boolean
}

interface ParsedCron {
  minute: Field
  hour: Field
  day: Field
  month: Field
  weekday: Field
}

function numberFor(raw: string, names: Record<string, number>, min: number, max: number): number {
  const lower = raw.toLowerCase()
  const value = lower in names ? names[lower]! : Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid cron value "${raw}"; expected ${min}-${max}.`)
  }
  return value
}

function parseField(
  source: string,
  min: number,
  max: number,
  names: Record<string, number> = {},
  normalize: (value: number) => number = value => value
): Field {
  const values = new Set<number>()
  const wildcard = source === '*'

  for (const part of source.split(',')) {
    if (!part) throw new Error('Cron fields cannot contain an empty list item.')
    const [rangeSource, stepSource, ...extra] = part.split('/')
    if (extra.length || !rangeSource) throw new Error(`Invalid cron field "${source}".`)
    const step = stepSource === undefined ? 1 : Number(stepSource)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${stepSource}".`)

    let start: number
    let end: number
    if (rangeSource === '*') {
      start = min
      end = max
    } else if (rangeSource.includes('-')) {
      const bits = rangeSource.split('-')
      if (bits.length !== 2) throw new Error(`Invalid cron range "${rangeSource}".`)
      start = numberFor(bits[0]!, names, min, max)
      end = numberFor(bits[1]!, names, min, max)
      if (end < start) throw new Error(`Cron range "${rangeSource}" runs backwards.`)
    } else {
      start = numberFor(rangeSource, names, min, max)
      end = stepSource === undefined ? start : max
    }
    for (let value = start; value <= end; value += step) values.add(normalize(value))
  }

  return { values, wildcard }
}

export function parseCronExpression(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error('A cron expression must have five fields: minute hour day month weekday.')
  }
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    day: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12, MONTHS),
    weekday: parseField(parts[4]!, 0, 7, WEEKDAYS, value => value === 7 ? 0 : value)
  }
}

export function validateTimezone(timezone: string): string {
  const value = timezone.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
  } catch {
    throw new Error(`Unknown time zone "${value}".`)
  }
  return value
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function zonedParts(date: Date, timezone: string) {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short'
    })
    formatters.set(timezone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday!.slice(0, 3).toLowerCase()]!
  }
}

function matchesCalendar(parsed: ParsedCron, value: ReturnType<typeof zonedParts>): boolean {
  const dayMatches = parsed.day.values.has(value.day)
  const weekdayMatches = parsed.weekday.values.has(value.weekday)
  // Vixie cron semantics: when both day fields are restricted, either matches.
  const calendarDayMatches = parsed.day.wildcard
    ? weekdayMatches
    : parsed.weekday.wildcard
      ? dayMatches
      : dayMatches || weekdayMatches
  return parsed.hour.values.has(value.hour)
    && parsed.month.values.has(value.month)
    && calendarDayMatches
}

/** Return the first scheduled minute strictly after `after`. */
export function nextCronOccurrence(expression: string, timezone: string, after: Date): Date {
  const parsed = parseCronExpression(expression)
  const zone = validateTimezone(timezone)
  const cursor = new Date(after.getTime())
  cursor.setUTCSeconds(0, 0)
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)

  // Five years accommodates leap-day expressions while keeping malformed or
  // impossible schedules (for example February 30) bounded.
  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60_000
  while (cursor.getTime() <= limit) {
    const value = zonedParts(cursor, zone)
    const minuteMatches = parsed.minute.values.has(value.minute)
    if (minuteMatches && matchesCalendar(parsed, value)) return cursor

    if (!minuteMatches) {
      // Jump straight to the next allowed minute in the local clock. Re-read
      // the zone afterwards: a DST boundary may have changed more than minutes.
      let delta = 1
      while (delta < 60 && !parsed.minute.values.has((value.minute + delta) % 60)) delta++
      cursor.setUTCMinutes(cursor.getUTCMinutes() + delta)
    } else {
      // The minute matched but the hour/date did not. Nothing else in this
      // local hour can be earlier than its next boundary. This reduces an
      // impossible five-year expression from millions of Intl projections to
      // roughly forty thousand without guessing across DST transitions.
      cursor.setUTCMinutes(cursor.getUTCMinutes() + (60 - value.minute))
    }
  }
  throw new Error('This cron expression has no occurrence in the next five years.')
}
