import type {
  AgentUsage,
  UsageLimit,
  UsageLimitSource,
  UsageLimitStatus
} from '../../../shared/types'

/**
 * Turning what each source actually says into the one shape the table stores.
 *
 * Everything here is pure, because every one of these payloads was read out of
 * a vendor bundle rather than a specification and each of them counts in its
 * own units. Claude's usage endpoint answers percentages and ISO timestamps;
 * the same account's `rate_limit_event` answers *fractions* and epoch seconds;
 * its response headers answer epoch seconds as strings; Codex answers percent
 * and epoch seconds. Normalising on write means the UI, the voice tool and the
 * tests all read one scale: percent 0-100, and an ISO 8601 string.
 */

/** A limit as the table stores it, minus the two columns the writer fills in. */
export type UsageLimitValue = Omit<UsageLimit, 'provider' | 'updatedAt'>

/** Sensible defaults, so every normaliser can build a row from a few fields. */
function limit(input: Partial<UsageLimitValue> & { limitId: string, label: string, source: UsageLimitSource }): UsageLimitValue {
  return {
    usedPercent: null,
    resetsAt: null,
    windowMinutes: null,
    status: null,
    amountUsed: null,
    amountLimit: null,
    currency: null,
    ...input
  }
}

/**
 * A percentage, 0-100, from a source that may be counting either way.
 *
 * `scale: 'fraction'` is the `rate_limit_event` path, whose own schema calls
 * utilization "the fraction of the window used (usually 0-1)" and allows it
 * past 1 when usage legitimately runs over a cap. The upper end is therefore
 * *not* clamped to 100 — a limit that is genuinely 120% used should say so
 * rather than quietly reading as exactly full.
 */
export function toPercent(value: unknown, scale: 'percent' | 'fraction'): number | null {
  const raw = typeof value === 'string' ? Number(value) : value
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const percent = scale === 'fraction' ? raw * 100 : raw
  if (percent < 0) return null
  return Math.round(percent * 10) / 10
}

/**
 * An ISO 8601 string from whatever a source calls a moment in time.
 *
 * All four shapes turn up in practice: Claude's endpoint sends ISO strings but
 * its own client also handles a number there; its headers and session events
 * send epoch *seconds*; Codex sends epoch seconds. Seconds and milliseconds are
 * told apart by magnitude — anything below ~Sep 2286 in milliseconds would be
 * an implausible 1970s date in seconds.
 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null
    const ms = value < 1e11 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string' || !value.trim()) return null
  // A bare number in a string is still a number.
  if (/^\d+$/.test(value.trim())) return toIso(Number(value.trim()))
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toStatus(value: unknown): UsageLimitStatus | null {
  return value === 'allowed' || value === 'allowed_warning' || value === 'rejected' ? value : null
}

function toFinite(value: unknown): number | null {
  const raw = typeof value === 'string' ? Number(value.trim()) : value
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

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
  seven_day_overage_included: 'Weekly · extra usage included',
  extra_usage: 'Usage credits',
  overage: 'Usage credits'
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
 * A Codex window's label, from the duration Codex reports rather than a name —
 * it has none for the windows themselves, only for the limit they belong to.
 * The wording mirrors codex-acp's own `/status` output.
 */
export function codexWindowLabel(windowMinutes: number | null, limitName?: string | null): string {
  const prefix = limitName && limitName !== 'codex' ? `${limitName} · ` : ''
  if (windowMinutes === null) return `${prefix}Limit`
  if (windowMinutes < 60) return `${prefix}${windowMinutes}m limit`
  if (windowMinutes < 1440) return `${prefix}${Math.round(windowMinutes / 60)}h limit`
  if (windowMinutes < 10080) return `${prefix}${Math.round(windowMinutes / 1440)}d limit`
  return `${prefix}Weekly limit`
}

/* ------------------------------------------------------------------ */
/* Claude: the OAuth usage endpoint                                    */
/* ------------------------------------------------------------------ */

/** The windows `GET /api/oauth/usage` answers with, in the order they read best. */
const CLAUDE_ENDPOINT_WINDOWS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps'
] as const

/**
 * `{ five_hour: { utilization, resets_at }, …, extra_usage, limits[] }` from
 * Claude's own usage endpoint — percentages and ISO timestamps.
 *
 * `model_scoped` / `limits[]` carries per-model weekly buckets whose labels are
 * server-supplied (`Fable`, `Opus`, …), so they are kept under a `model:` id
 * rather than guessed at. A window the account does not have is simply absent,
 * and a window present but null-utilization is dropped: a row that renders as
 * 0% would be a lie about an account that has no such limit.
 */
export function claudeEndpointLimits(body: any): UsageLimitValue[] {
  if (!body || typeof body !== 'object') return []
  const out: UsageLimitValue[] = []

  for (const id of CLAUDE_ENDPOINT_WINDOWS) {
    const window = body[id]
    if (!window || typeof window !== 'object') continue
    const usedPercent = toPercent(window.utilization, 'percent')
    if (usedPercent === null) continue
    out.push(limit({
      limitId: id,
      label: claudeLabel(id),
      usedPercent,
      resetsAt: toIso(window.resets_at),
      windowMinutes: id === 'five_hour' ? 300 : 10080,
      source: 'endpoint'
    }))
  }

  // Per-model weekly buckets: `model_scoped` when the CLI has already projected
  // them, the raw `limits[]` array when this is the endpoint's own body.
  const scoped: any[] = Array.isArray(body.model_scoped)
    ? body.model_scoped
    : (Array.isArray(body.limits) ? body.limits : [])
      .filter((entry: any) => entry?.kind === 'weekly_scoped' && entry?.scope?.model?.display_name)
      .map((entry: any) => ({
        display_name: entry.scope.model.display_name,
        utilization: entry.percent,
        resets_at: entry.resets_at
      }))
  for (const entry of scoped) {
    const name = typeof entry?.display_name === 'string' ? entry.display_name : null
    const usedPercent = toPercent(entry?.utilization, 'percent')
    if (!name || usedPercent === null) continue
    out.push(limit({
      limitId: `model:${name}`,
      label: claudeLabel(`model:${name}`),
      usedPercent,
      resetsAt: toIso(entry.resets_at),
      windowMinutes: 10080,
      source: 'endpoint'
    }))
  }

  const extra = body.extra_usage
  // Only worth a row once the account actually has extra usage turned on;
  // otherwise "$0.00 of $0.00" is noise on every plan that never opted in.
  if (extra && typeof extra === 'object' && extra.is_enabled === true) {
    out.push(limit({
      limitId: 'extra_usage',
      label: claudeLabel('extra_usage'),
      usedPercent: toPercent(extra.utilization, 'percent'),
      amountUsed: toFinite(extra.used_credits),
      amountLimit: toFinite(extra.monthly_limit),
      currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
      source: 'endpoint'
    }))
  }

  return out
}

/* ------------------------------------------------------------------ */
/* Claude: the unified rate-limit response headers                     */
/* ------------------------------------------------------------------ */

/**
 * `anthropic-ratelimit-unified-*` off any OAuth-authenticated API response.
 *
 * This is Domo's **primary** source for Claude plan limits, because the usage
 * endpoint turns out not to be reachable with a `claude setup-token` token
 * (see `fetchClaudeUsage`). The names came out of the Claude Code binary; the
 * units came off a real response, and one of them is a trap:
 *
 * - `-utilization` is a **fraction**, not a percentage. A real response carried
 *   `5h-utilization: 0.41` for a window that was 41% spent. Read as a
 *   percentage that is "0.4%" — a nearly-half-spent plan rendered as untouched,
 *   which is the single most reassuring way this feature could be wrong.
 * - `-reset` is epoch **seconds**, as a string.
 * - there is a `-status` *per window* (`-5h-status`, `-7d-status`) as well as
 *   the overall one. The per-window value is the honest one for a row; the
 *   overall header describes the request that happened to carry it.
 *
 * Only the two subscription windows and the overage are taken. The rest of the
 * family (`-representative-claim`, `-fallback-percentage`, `-slow-*`,
 * `-grace-*`) describes which window is currently limiting and how this one
 * request was degraded, which is not a property of the plan.
 */
export function claudeHeaderLimits(headers: Record<string, string | null | undefined>): UsageLimitValue[] {
  const get = (name: string) => {
    const value = headers[name] ?? headers[name.toLowerCase()]
    return value === null || value === undefined || value === '' ? null : String(value)
  }
  const overall = toStatus(get('anthropic-ratelimit-unified-status'))
  const out: UsageLimitValue[] = []

  for (const [prefix, id, minutes] of [
    ['5h', 'five_hour', 300],
    ['7d', 'seven_day', 10080]
  ] as const) {
    const usedPercent = toPercent(get(`anthropic-ratelimit-unified-${prefix}-utilization`), 'fraction')
    if (usedPercent === null) continue
    out.push(limit({
      limitId: id,
      label: claudeLabel(id),
      usedPercent,
      resetsAt: toIso(get(`anthropic-ratelimit-unified-${prefix}-reset`)),
      windowMinutes: minutes,
      status: toStatus(get(`anthropic-ratelimit-unified-${prefix}-status`)) ?? overall,
      source: 'headers'
    }))
  }

  // Only when there is a number. A response from an account with no extra usage
  // carries `overage-status: rejected` and `overage-disabled-reason:
  // out_of_credits` with no utilization at all — which means "you have not
  // bought any", not "you have hit a limit", and must not render as either.
  const overagePercent = toPercent(get('anthropic-ratelimit-unified-overage-utilization'), 'fraction')
  if (overagePercent !== null) {
    out.push(limit({
      limitId: 'extra_usage',
      label: claudeLabel('extra_usage'),
      usedPercent: overagePercent,
      resetsAt: toIso(get('anthropic-ratelimit-unified-overage-reset')),
      status: toStatus(get('anthropic-ratelimit-unified-overage-status')),
      currency: 'USD',
      source: 'headers'
    }))
  }

  return out
}

/* ------------------------------------------------------------------ */
/* Claude: what rides in on a working agent                            */
/* ------------------------------------------------------------------ */

/**
 * `_meta["_claude/rateLimit"]` on a `usage_update`, i.e. the SDK's
 * `SDKRateLimitInfo`.
 *
 * Two things about it are easy to get wrong, and both were read off the SDK's
 * own schema rather than assumed. Its `utilization` is a **fraction**, not a
 * percentage — the field is documented as "the fraction of the window used
 * (usually 0-1)" — so a reading of 0.52 means 52%, and treating it as a percent
 * would show a nearly-full plan as barely touched. And `resetsAt` is epoch
 * seconds, not milliseconds and not ISO.
 *
 * `unifiedWindows` is the useful part: unlike the top-level pair, which only
 * ever describes whichever window is currently limiting, it carries every
 * window the account has on every observation. The top-level fields are used
 * only to fill in a window `unifiedWindows` did not mention.
 */
export function claudeSessionLimits(info: any): UsageLimitValue[] {
  if (!info || typeof info !== 'object') return []
  const status = toStatus(info.status)
  const out = new Map<string, UsageLimitValue>()

  const windows = info.unifiedWindows
  if (windows && typeof windows === 'object') {
    for (const [id, minutes] of [
      ['five_hour', 300],
      ['seven_day', 10080],
      ['seven_day_overage_included', 10080]
    ] as const) {
      const window = windows[id]
      const usedPercent = toPercent(window?.utilization, 'fraction')
      if (usedPercent === null) continue
      out.set(id, limit({
        limitId: id,
        label: claudeLabel(id),
        usedPercent,
        resetsAt: toIso(window.resetsAt),
        windowMinutes: minutes,
        status,
        source: 'session-event'
      }))
    }
  }

  // The window that is limiting right now, when it is one `unifiedWindows` did
  // not carry. `rateLimitType` is optional, so a reading without one names no
  // window at all and is not a row.
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : null
  const topPercent = toPercent(info.utilization, 'fraction')
  if (type && topPercent !== null && !out.has(type)) {
    out.set(type, limit({
      limitId: type,
      label: claudeLabel(type),
      usedPercent: topPercent,
      resetsAt: toIso(info.resetsAt),
      windowMinutes: type === 'five_hour' ? 300 : type === 'overage' ? null : 10080,
      status,
      source: 'session-event'
    }))
  }

  const overageStatus = toStatus(info.overageStatus)
  if (overageStatus && !out.has('extra_usage')) {
    out.set('extra_usage', limit({
      limitId: 'extra_usage',
      label: claudeLabel('extra_usage'),
      resetsAt: toIso(info.overageResetsAt),
      status: overageStatus,
      currency: 'USD',
      source: 'session-event'
    }))
  }

  return [...out.values()]
}

/* ------------------------------------------------------------------ */
/* Codex: account/rateLimits/read                                      */
/* ------------------------------------------------------------------ */

/**
 * `{ rateLimits, rateLimitsByLimitId }` from a `codex app-server`.
 *
 * Each snapshot is up to two windows (`primary` / `secondary`, already percent
 * and epoch seconds) plus a credit balance, so one snapshot becomes several
 * rows under `<limitId>:primary`, `<limitId>:secondary` and `<limitId>:credits`.
 * The fallback to the bare `rateLimits` when `rateLimitsByLimitId` is empty
 * mirrors codex-acp's own `createRateLimitsMap`, including its `"codex"`
 * default id.
 */
export function codexLimits(response: any): UsageLimitValue[] {
  if (!response || typeof response !== 'object') return []

  const byId: Array<[string, any]> = Object.entries(response.rateLimitsByLimitId ?? {})
    .filter(([, snapshot]) => snapshot !== undefined && snapshot !== null)
  if (byId.length === 0 && response.rateLimits) {
    byId.push([response.rateLimits.limitId ?? 'codex', response.rateLimits])
  }

  const out: UsageLimitValue[] = []
  for (const [fallbackId, snapshot] of byId) {
    if (!snapshot || typeof snapshot !== 'object') continue
    const limitId = typeof snapshot.limitId === 'string' ? snapshot.limitId : fallbackId
    const limitName = typeof snapshot.limitName === 'string' ? snapshot.limitName : null

    for (const window of ['primary', 'secondary'] as const) {
      const value = snapshot[window]
      const usedPercent = toPercent(value?.usedPercent, 'percent')
      if (usedPercent === null) continue
      const windowMinutes = toFinite(value.windowDurationMins)
      out.push(limit({
        limitId: `${limitId}:${window}`,
        label: codexWindowLabel(windowMinutes, limitName),
        usedPercent,
        resetsAt: toIso(value.resetsAt),
        windowMinutes,
        source: 'app-server'
      }))
    }

    // An unlimited balance is worth saying out loud; a missing one is not a row.
    const credits = snapshot.credits
    if (credits && typeof credits === 'object') {
      const balance = toFinite(credits.balance)
      if (credits.unlimited === true || balance !== null) {
        out.push(limit({
          limitId: `${limitId}:credits`,
          label: limitName && limitName !== 'codex' ? `${limitName} · Credits` : 'Credits',
          amountUsed: credits.unlimited === true ? null : balance,
          currency: 'credits',
          source: 'app-server'
        }))
      }
    }

    const individual = snapshot.individualLimit
    if (individual && typeof individual === 'object') {
      const used = toFinite(individual.used)
      const cap = toFinite(individual.limit)
      if (used !== null && cap !== null) {
        out.push(limit({
          limitId: `${limitId}:individual`,
          label: limitName && limitName !== 'codex' ? `${limitName} · Spend limit` : 'Spend limit',
          usedPercent: cap > 0 ? toPercent((used / cap) * 100, 'percent') : null,
          resetsAt: toIso(individual.resetsAt),
          amountUsed: used,
          amountLimit: cap,
          currency: 'credits',
          source: 'app-server'
        }))
      }
    }
  }

  return out
}

/* ------------------------------------------------------------------ */
/* the ACP usage_update itself                                         */
/* ------------------------------------------------------------------ */

/**
 * An ACP `usage_update` turned into the session's `usage` column.
 *
 * Defensive on purpose. `size` is the adapter's idea of the context window and
 * starts as a *guess* — claude-agent-acp streams a default until the first
 * turn result carries an authoritative `modelUsage.contextWindow`, and
 * third-party backends have been seen answering a non-positive or NaN one. A
 * bad size must not throw away the good one already on the row, so `previous`
 * is kept instead; with no previous either, there is nothing worth writing.
 *
 * `used` can legitimately fall — a `compact_boundary` frees occupancy — so it
 * is clamped at zero and never at its own previous value.
 */
export function normalizeAgentUsage(update: any, previous: AgentUsage | null = null): AgentUsage | null {
  const used = toFinite(update?.used)
  if (used === null) return null

  const reported = toFinite(update?.size)
  const size = reported !== null && reported > 0 ? reported : previous?.context.size ?? null
  if (size === null) return null

  const usage: AgentUsage = {
    context: { used: Math.max(0, used), size },
    updatedAt: new Date().toISOString()
  }

  // `cost: null` is the ordinary shape mid-stream; only a turn result carries
  // one. Keep the last known cost rather than dropping it on every delta.
  const amount = toFinite(update?.cost?.amount)
  if (amount !== null) {
    usage.cost = {
      amount,
      currency: typeof update.cost.currency === 'string' ? update.cost.currency : 'USD'
    }
  } else if (previous?.cost) {
    usage.cost = previous.cost
  }

  return usage
}

/** Whether two readings say the same thing, ignoring when they were taken. */
export function sameAgentUsage(a: AgentUsage | null, b: AgentUsage | null): boolean {
  if (!a || !b) return a === b
  return a.context.used === b.context.used
    && a.context.size === b.context.size
    && a.cost?.amount === b.cost?.amount
    && a.cost?.currency === b.cost?.currency
}
