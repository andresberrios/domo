import type { UsageLimit } from '~~/shared/types'

/**
 * Formatters for everything the usage surfaces render.
 *
 * Pure and unit-tested, because every one of them is a place where a plausible
 * shortcut is wrong: rounding a percentage the wrong way makes a full plan look
 * survivable, and "resets in -3 min" is a clock skew the user cannot act on.
 */

/** `189.2k`, `1M`, `847` — the compact form Claude Code's own panel uses. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens)) return '—'
  const value = Math.max(0, Math.round(tokens))
  // One decimal, and `Number()` drops a trailing `.0` — so 1,048,576 reads as
  // "1M" rather than "1.0M", and 189,200 keeps the tenth that distinguishes it
  // from 189,900.
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`
  return String(value)
}

/** A whole percent, for a bar and a label that have to agree with each other. */
export function percentOf(used: number, size: number | null | undefined): number | null {
  if (!size || !Number.isFinite(size) || size <= 0) return null
  if (!Number.isFinite(used)) return null
  return Math.round((Math.max(0, used) / size) * 100)
}

/** `52%`, and `—` for a window whose utilization nobody has reported. */
export function formatPercent(percent: number | null | undefined): string {
  return typeof percent === 'number' && Number.isFinite(percent) ? `${Math.round(percent)}%` : '—'
}

/** `$15.95`, or `1,250 credits` for a provider that counts in its own units. */
export function formatAmount(amount: number | null | undefined, currency: string | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  if (!currency || currency === 'credits') {
    return `${Math.round(amount).toLocaleString()}${currency === 'credits' ? ' credits' : ''}`
  }
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    // An unknown currency code throws rather than degrading, and a limit row is
    // not worth an exception.
    return `${amount.toFixed(2)} ${currency}`
  }
}

/**
 * "Resets in 3 hr 41 min" while that is a useful thing to say, and a weekday
 * and time once it is not: "in 4 days 2 hr" is harder to picture than "Tue 11 PM".
 */
export function formatReset(resetsAt: string | null | undefined, now: number = Date.now()): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const ms = at - now
  // A window whose reset has passed but whose reading has not caught up yet.
  if (ms <= 0) return 'Resetting now'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `Resets in ${Math.max(1, minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest ? `Resets in ${hours} hr ${rest} min` : `Resets in ${hours} hr`
  }
  return `Resets ${new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })}`
}

/**
 * "as of 12 min ago", and nothing at all while the reading is current.
 *
 * The polls are far apart — Claude's usage endpoint answers about once an hour
 * — so a number on screen is routinely minutes or tens of minutes old. Saying
 * so is the difference between a stale reading and a wrong one.
 */
export function formatStaleness(updatedAt: string | null | undefined, now: number = Date.now()): string {
  if (!updatedAt) return ''
  const at = Date.parse(updatedAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 2) return ''
  if (minutes < 60) return `as of ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `as of ${hours} hr ago`
  return `as of ${Math.round(hours / 24)} d ago`
}

export type UsageTone = 'neutral' | 'primary' | 'warning' | 'error'

/**
 * What colour a bar is.
 *
 * `rejected` is red whatever the percentage says: a window can be refusing
 * requests at a utilization below 100, and the colour has to follow the
 * consequence rather than the number.
 */
export function usageTone(percent: number | null | undefined, status?: UsageLimit['status']): UsageTone {
  if (status === 'rejected') return 'error'
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'neutral'
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'primary'
}

/**
 * A label for a limit whose row carries none.
 *
 * The server names every row it writes, so this is only reached by a row from
 * an older or hand-edited database — worth a readable fallback rather than an
 * empty cell.
 */
export function limitLabel(limitId: string): string {
  const known: Record<string, string> = {
    five_hour: '5-hour limit',
    seven_day: 'Weekly · all models',
    seven_day_opus: 'Weekly · Opus',
    seven_day_sonnet: 'Weekly · Sonnet',
    extra_usage: 'Usage credits'
  }
  return known[limitId] ?? limitId
}

/** The worst window of a set, which is the one a compact summary should show. */
export function worstLimit(limits: UsageLimit[]): UsageLimit | null {
  let worst: UsageLimit | null = null
  for (const limit of limits) {
    if (limit.usedPercent === null) continue
    if (!worst || limit.usedPercent > worst.usedPercent!) worst = limit
  }
  return worst
}

/**
 * The two windows every provider reports: the 5-hour limit that actually
 * stops work today, and the weekly one behind it. `five_hour` and Codex's
 * `<id>:primary` both report a ~300-minute window; anything past half a day
 * is the weekly side, whatever the provider calls it (`seven_day`, `<id>:secondary`).
 */
export function fiveHourLimit(limits: UsageLimit[]): UsageLimit | null {
  return limits.find(l => l.windowMinutes !== null && l.windowMinutes <= 360) ?? null
}

/**
 * The weekly window. Claude reports several 10080-minute rows (the overall
 * figure plus a per-model breakdown); `seven_day` is the aggregate one and is
 * preferred, falling back to the worst of whatever weekly rows exist.
 */
export function weeklyLimit(limits: UsageLimit[]): UsageLimit | null {
  const candidates = limits.filter(l => l.windowMinutes !== null && l.windowMinutes! > 360)
  if (!candidates.length) return null
  return candidates.find(l => l.limitId === 'seven_day') ?? worstLimit(candidates)
}
