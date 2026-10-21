import type { UsageLimit, UsageProviderId } from './types'

/**
 * How a stored plan-limit row reads, decided when it is read rather than when
 * it was written.
 *
 * A row can sit unrewritten for days: Claude's `seven_day_overage_included`
 * comes only from session events, so an idle account keeps whatever an older
 * Domo wrote. Labels are therefore derived from the row's id with today's
 * code, and a window whose reset has passed is shown as reset, not at the
 * number it had before. Shared so the server's tools and the UI agree.
 */

/**
 * The model behind Claude's `seven_day_overage_included` window, for the
 * sources that report that window without naming it (the rate-limit headers
 * and session events). It is the weekly bucket of the models whose use beyond
 * the plan needs extra usage. Claude Code itself labels it "Fable limit" (its
 * rate-limit label map, 2.1.296). The usage endpoint names the same bucket in
 * `limits[]`, and that name wins wherever it is available (`model:<name>`).
 */
const OVERAGE_INCLUDED_MODEL = 'Fable'

/**
 * What each Claude window is called, matching the wording Claude Code's own
 * `/usage` uses so the two can be read side by side.
 */
const CLAUDE_LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
  seven_day_oauth_apps: 'Weekly · OAuth apps',
  seven_day_overage_included: `Weekly · ${OVERAGE_INCLUDED_MODEL}`,
  extra_usage: 'Extra usage',
  overage: 'Extra usage'
}

export function claudeLabel(limitId: string): string {
  const known = CLAUDE_LABELS[limitId]
  if (known) return known
  // `model:Fable`, from the endpoint's per-model weekly buckets.
  const scoped = /^model:(.+)$/.exec(limitId)
  if (scoped) return `Weekly · ${scoped[1]}`
  return limitId
}

/**
 * A row's label. Claude's ids name the window, so its label always comes from
 * the current table; the other providers name rows from what their source
 * said (a limit name, a window length), which only the stored label keeps.
 */
export function usageLimitLabel(limit: Pick<UsageLimit, 'limitId' | 'label'> & { provider: UsageProviderId }): string {
  if (limit.provider === 'claude') return claudeLabel(limit.limitId)
  return limit.label || limit.limitId
}

/**
 * Whether the window this row measures has reset since it was read.
 *
 * Then the reading is known to be out of date, and in one direction: the
 * window starts again from nothing. Only a row that measures a window counts;
 * a balance with a reset date (a monthly credit cap) is not zeroed.
 */
export function usageResetPassed(
  limit: Pick<UsageLimit, 'resetsAt' | 'updatedAt' | 'usedPercent'>,
  now: number = Date.now()
): boolean {
  if (!limit.resetsAt || limit.usedPercent === null) return false
  const resetsAt = Date.parse(limit.resetsAt)
  if (Number.isNaN(resetsAt) || resetsAt > now) return false
  const updatedAt = Date.parse(limit.updatedAt)
  return Number.isNaN(updatedAt) || updatedAt < resetsAt
}

/** A row as it should be read now: today's label, and a passed reset applied. */
export function currentUsageLimit<T extends UsageLimit>(limit: T, now: number = Date.now()): T & { resetPassed: boolean } {
  const label = usageLimitLabel(limit)
  if (!usageResetPassed(limit, now)) return { ...limit, label, resetPassed: false }
  // A refusal belonged to the window that ended; the next reset is unknown
  // until the source is asked again.
  return {
    ...limit,
    label,
    usedPercent: 0,
    status: limit.status === 'rejected' || limit.status === 'allowed_warning' ? 'allowed' : limit.status,
    resetsAt: null,
    resetPassed: true
  }
}
