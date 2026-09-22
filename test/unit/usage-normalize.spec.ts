import { describe, expect, it } from 'vitest'

import {
  claudeEndpointLimits,
  claudeHeaderLimits,
  claudeSessionLimits,
  codexLimits,
  codexWindowLabel,
  normalizeAgentUsage,
  sameAgentUsage,
  toIso,
  toPercent
} from '../../server/lib/usage/normalize'

/**
 * Every payload below was shaped from the vendors' own code, not invented:
 * the endpoint body from the response schema in the Claude Code 2.1.270 binary
 * (`five_hour`/`seven_day`/`extra_usage`/`limits[]`, utilization 0-100, ISO
 * resets), the headers from the `anthropic-ratelimit-unified-*` family in the
 * same binary (epoch seconds, as strings), `_claude/rateLimit` from the SDK's
 * `SDKRateLimitInfo` zod schema (utilization a **fraction**, `resetsAt` epoch
 * seconds), and the Codex snapshot from codex-acp's `createRateLimitsMap` and
 * `formatSingleRateLimit`.
 *
 * The units are the whole point of this layer: three sources, three scales, and
 * every one of them would render plausibly wrong if taken at face value.
 */

describe('toPercent', () => {
  it('passes a percentage through and multiplies a fraction', () => {
    expect(toPercent(52, 'percent')).toBe(52)
    expect(toPercent(0.52, 'fraction')).toBe(52)
  })

  it('does not clamp a window that is genuinely over its cap', () => {
    // The SDK's own schema notes utilization above 1 happens when usage runs
    // past a window's limit. Clamping it to 100 would read as "exactly full".
    expect(toPercent(1.2, 'fraction')).toBe(120)
  })

  it('is null for anything that is not a number', () => {
    expect(toPercent(undefined, 'percent')).toBeNull()
    expect(toPercent(Number.NaN, 'percent')).toBeNull()
    expect(toPercent('nope', 'percent')).toBeNull()
    expect(toPercent(-1, 'percent')).toBeNull()
  })

  it('reads a numeric string, which is what a header carries', () => {
    expect(toPercent('37', 'percent')).toBe(37)
  })
})

describe('toIso', () => {
  it('reads epoch seconds, which is what the headers and session events use', () => {
    expect(toIso(1_790_000_000)).toBe(new Date(1_790_000_000_000).toISOString())
    expect(toIso('1790000000')).toBe(new Date(1_790_000_000_000).toISOString())
  })

  it('reads epoch milliseconds without mistaking them for seconds', () => {
    expect(toIso(1_790_000_000_000)).toBe(new Date(1_790_000_000_000).toISOString())
  })

  it('passes an ISO string through, which is what the endpoint sends', () => {
    expect(toIso('2026-09-21T17:00:00Z')).toBe('2026-09-21T17:00:00.000Z')
  })

  it('is null for nothing, and for nonsense', () => {
    expect(toIso(null)).toBeNull()
    expect(toIso(undefined)).toBeNull()
    expect(toIso(0)).toBeNull()
    expect(toIso('later')).toBeNull()
  })
})

describe('the Claude usage endpoint', () => {
  /** A body shaped like `GET /api/oauth/usage` answers, values made up. */
  const body = {
    five_hour: { utilization: 52, resets_at: '2026-09-21T17:00:00Z' },
    seven_day: { utilization: 31, resets_at: '2026-09-26T00:00:00Z' },
    seven_day_opus: { utilization: 8, resets_at: '2026-09-26T00:00:00Z' },
    seven_day_sonnet: null,
    extra_usage: {
      is_enabled: true,
      monthly_limit: 100,
      used_credits: 15.95,
      utilization: 15.95,
      currency: 'USD'
    }
  }

  it('reads every window the account has, in percent and ISO', () => {
    const limits = claudeEndpointLimits(body)

    expect(limits.map(limit => limit.limitId)).toEqual([
      'five_hour', 'seven_day', 'seven_day_opus', 'extra_usage'
    ])
    expect(limits[0]).toMatchObject({
      label: '5-hour limit',
      usedPercent: 52,
      resetsAt: '2026-09-21T17:00:00.000Z',
      windowMinutes: 300,
      source: 'endpoint'
    })
  })

  it('renders credits as money, which is what that row means', () => {
    const credits = claudeEndpointLimits(body).find(limit => limit.limitId === 'extra_usage')

    expect(credits).toMatchObject({
      label: 'Usage credits',
      amountUsed: 15.95,
      amountLimit: 100,
      currency: 'USD'
    })
  })

  it('leaves out extra usage the account never turned on', () => {
    // "$0.00 of $0.00" on every plan that did not opt in is noise, not data.
    const limits = claudeEndpointLimits({ ...body, extra_usage: { is_enabled: false } })

    expect(limits.map(limit => limit.limitId)).not.toContain('extra_usage')
  })

  it('drops a window that is present but has no reading, rather than calling it 0%', () => {
    const limits = claudeEndpointLimits({ five_hour: { utilization: null, resets_at: null } })

    expect(limits).toEqual([])
  })

  it('reads the per-model weekly buckets out of the raw limits array', () => {
    const limits = claudeEndpointLimits({
      limits: [
        { kind: 'weekly_scoped', scope: { model: { display_name: 'Opus' } }, percent: 44, resets_at: 1_790_000_000 },
        { kind: 'five_hour' }
      ]
    })

    expect(limits).toEqual([expect.objectContaining({
      limitId: 'model:Opus',
      label: 'Weekly · Opus',
      usedPercent: 44,
      resetsAt: new Date(1_790_000_000_000).toISOString()
    })])
  })

  it('is empty rather than throwing for a body that is not one', () => {
    expect(claudeEndpointLimits(null)).toEqual([])
    expect(claudeEndpointLimits('rate limited')).toEqual([])
  })
})

describe('the unified rate-limit headers', () => {
  /**
   * Copied from a real 200 off `POST /v1/messages` with a `claude setup-token`
   * token, values as they actually arrived. The scale is the whole point: the
   * response really did say `0.41` for a window that was 41% spent.
   */
  const headers = {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': '1790055600',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.41',
    'anthropic-ratelimit-unified-5h-reset': '1790055600',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.67',
    'anthropic-ratelimit-unified-7d-reset': '1790110800',
    'anthropic-ratelimit-unified-fallback-percentage': '0.5',
    'anthropic-ratelimit-unified-overage-status': 'rejected',
    'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits'
  }

  it('reads utilization as a fraction, which is what it really is', () => {
    // Read as a percentage, a 41%-spent window renders as "0%" — the most
    // reassuring possible way for this feature to be wrong.
    const limits = claudeHeaderLimits(headers)

    expect(limits).toEqual([
      expect.objectContaining({
        limitId: 'five_hour',
        usedPercent: 41,
        resetsAt: new Date(1_790_055_600_000).toISOString(),
        windowMinutes: 300,
        status: 'allowed',
        source: 'headers'
      }),
      expect.objectContaining({
        limitId: 'seven_day',
        usedPercent: 67,
        resetsAt: new Date(1_790_110_800_000).toISOString()
      })
    ])
  })

  it('prefers the per-window status over the one describing the request', () => {
    const limits = claudeHeaderLimits({
      ...headers,
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning'
    })

    expect(limits.find(l => l.limitId === 'seven_day')!.status).toBe('allowed_warning')
  })

  it('falls back to the overall status for a window that has none of its own', () => {
    const { 'anthropic-ratelimit-unified-5h-status': _dropped, ...rest } = headers
    const limits = claudeHeaderLimits({ ...rest, 'anthropic-ratelimit-unified-status': 'allowed_warning' })

    expect(limits.find(l => l.limitId === 'five_hour')!.status).toBe('allowed_warning')
  })

  it('does not invent a credits row for an account that has no credits', () => {
    // The real response carries `overage-status: rejected` with
    // `overage-disabled-reason: out_of_credits` and no utilization at all. That
    // means "you never bought any", not "you have hit a limit", and rendering
    // it as a spent bar would be a straightforward lie.
    expect(claudeHeaderLimits(headers).map(limit => limit.limitId))
      .not.toContain('extra_usage')
  })

  it('reads the overage window as the credits row when there is a number', () => {
    const limits = claudeHeaderLimits({
      ...headers,
      'anthropic-ratelimit-unified-overage-utilization': '0.4',
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-reset': '1790700000'
    })

    expect(limits).toContainEqual(expect.objectContaining({
      limitId: 'extra_usage',
      usedPercent: 40,
      status: 'allowed'
    }))
  })

  it('takes nothing from a response that carried none of them', () => {
    expect(claudeHeaderLimits({ 'content-type': 'application/json' })).toEqual([])
  })
})

describe('_claude/rateLimit, as it rides in on a working agent', () => {
  it('reads unifiedWindows as fractions, not percentages', () => {
    // The single most dangerous unit in this feature: 0.52 here means 52%, and
    // reading it as a percentage would show a half-spent plan as barely used.
    const limits = claudeSessionLimits({
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.52, resetsAt: 1_790_000_000 },
        seven_day: { utilization: 0.31, resetsAt: 1_790_600_000 }
      }
    })

    expect(limits).toEqual([
      expect.objectContaining({
        limitId: 'five_hour',
        usedPercent: 52,
        resetsAt: new Date(1_790_000_000_000).toISOString(),
        status: 'allowed',
        source: 'session-event'
      }),
      expect.objectContaining({ limitId: 'seven_day', usedPercent: 31 })
    ])
  })

  it('falls back to the limiting window when unifiedWindows is absent', () => {
    const limits = claudeSessionLimits({
      status: 'rejected',
      rateLimitType: 'seven_day_opus',
      utilization: 1,
      resetsAt: 1_790_600_000
    })

    expect(limits).toEqual([expect.objectContaining({
      limitId: 'seven_day_opus',
      label: 'Weekly · Opus',
      usedPercent: 100,
      status: 'rejected'
    })])
  })

  it('prefers unifiedWindows over the top-level pair for the same window', () => {
    // The top-level fields describe whichever window is limiting *now*;
    // unifiedWindows is tracked on every observation. Same window, one row.
    const limits = claudeSessionLimits({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 0.9,
      unifiedWindows: { five_hour: { utilization: 0.52, resetsAt: 1_790_000_000 } }
    })

    expect(limits).toHaveLength(1)
    expect(limits[0]!.usedPercent).toBe(52)
  })

  it('names no window when the event names none', () => {
    // `rateLimitType` is optional; a reading without one cannot be attributed.
    expect(claudeSessionLimits({ status: 'allowed', utilization: 0.4 })).toEqual([])
  })

  it('is empty rather than throwing for a shape it does not recognise', () => {
    expect(claudeSessionLimits(null)).toEqual([])
    expect(claudeSessionLimits('rejected')).toEqual([])
  })
})

describe('codex app-server rate limits', () => {
  const response = {
    rateLimitsByLimitId: {
      plan: {
        limitId: 'plan',
        limitName: 'Plus',
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_790_000_000 },
        secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1_790_600_000 },
        credits: { unlimited: false, balance: 1250 }
      }
    }
  }

  it('splits one snapshot into a row per window', () => {
    const limits = codexLimits(response)

    expect(limits.map(limit => limit.limitId)).toEqual(['plan:primary', 'plan:secondary', 'plan:credits'])
    expect(limits[0]).toMatchObject({
      label: 'Plus · 5h limit',
      usedPercent: 42,
      windowMinutes: 300,
      resetsAt: new Date(1_790_000_000_000).toISOString(),
      source: 'app-server'
    })
    expect(limits[1]!.label).toBe('Plus · Weekly limit')
  })

  it('falls back to the bare rateLimits when nothing is keyed by id', () => {
    // codex-acp's own `createRateLimitsMap` does exactly this, down to the
    // `"codex"` default id.
    const limits = codexLimits({
      rateLimitsByLimitId: {},
      rateLimits: { primary: { usedPercent: 12, windowDurationMins: 60, resetsAt: null } }
    })

    expect(limits).toEqual([expect.objectContaining({ limitId: 'codex:primary', label: '1h limit' })])
  })

  it('copes with a snapshot that has no secondary window', () => {
    const limits = codexLimits({
      rateLimitsByLimitId: { plan: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null } } }
    })

    expect(limits.map(limit => limit.limitId)).toEqual(['plan:primary'])
  })

  it('records an unlimited balance as a row with no amount', () => {
    const limits = codexLimits({
      rateLimitsByLimitId: { plan: { credits: { unlimited: true } } }
    })

    expect(limits).toEqual([expect.objectContaining({ limitId: 'plan:credits', amountUsed: null })])
  })

  it('turns an individual spend limit into a percentage of its own cap', () => {
    const limits = codexLimits({
      rateLimitsByLimitId: {
        plan: { individualLimit: { used: '40', limit: '200', remainingPercent: 80, resetsAt: 1_790_000_000 } }
      }
    })

    expect(limits).toEqual([expect.objectContaining({
      limitId: 'plan:individual',
      usedPercent: 20,
      amountUsed: 40,
      amountLimit: 200
    })])
  })

  it('is empty rather than throwing for a response that is not one', () => {
    expect(codexLimits(null)).toEqual([])
    expect(codexLimits({})).toEqual([])
  })
})

describe('codexWindowLabel', () => {
  it('describes a window by its duration, mirroring codex-acp own /status', () => {
    expect(codexWindowLabel(30)).toBe('30m limit')
    expect(codexWindowLabel(300)).toBe('5h limit')
    expect(codexWindowLabel(2880)).toBe('2d limit')
    expect(codexWindowLabel(10080)).toBe('Weekly limit')
    expect(codexWindowLabel(null)).toBe('Limit')
  })
})

describe('the ACP usage_update itself', () => {
  it('reads the reading', () => {
    expect(normalizeAgentUsage({ used: 189_200, size: 1_000_000 })).toMatchObject({
      context: { used: 189_200, size: 1_000_000 }
    })
  })

  it('tolerates cost: null, which is the ordinary mid-stream shape', () => {
    expect(normalizeAgentUsage({ used: 10, size: 100, cost: null })).toMatchObject({
      context: { used: 10, size: 100 }
    })
  })

  it('keeps the last known cost rather than dropping it on every delta', () => {
    const previous = normalizeAgentUsage({ used: 10, size: 100, cost: { amount: 0.42, currency: 'USD' } })
    const next = normalizeAgentUsage({ used: 20, size: 100 }, previous)

    expect(next!.cost).toEqual({ amount: 0.42, currency: 'USD' })
  })

  it('keeps the window it already knew when a reading reports a bad one', () => {
    // Third-party backends have been observed answering a non-positive or NaN
    // context window; discarding the good one would make the bar jump.
    const previous = normalizeAgentUsage({ used: 10, size: 200_000 })

    expect(normalizeAgentUsage({ used: 20, size: 0 }, previous)!.context.size).toBe(200_000)
    expect(normalizeAgentUsage({ used: 20, size: Number.NaN }, previous)!.context.size).toBe(200_000)
  })

  it('is null when there is no window at all, rather than inventing one', () => {
    expect(normalizeAgentUsage({ used: 20, size: 0 })).toBeNull()
    expect(normalizeAgentUsage({ size: 100 })).toBeNull()
  })

  it('clamps used at zero but never at its previous value', () => {
    // A compact_boundary frees occupancy, so `used` legitimately falls.
    const previous = normalizeAgentUsage({ used: 150_000, size: 200_000 })

    expect(normalizeAgentUsage({ used: 12_000, size: 200_000 }, previous)!.context.used).toBe(12_000)
    expect(normalizeAgentUsage({ used: -5, size: 200_000 })!.context.used).toBe(0)
  })
})

describe('sameAgentUsage', () => {
  it('ignores the timestamp, so an identical reading writes nothing', () => {
    const a = { context: { used: 1, size: 2 }, updatedAt: '2026-01-01T00:00:00.000Z' }
    const b = { context: { used: 1, size: 2 }, updatedAt: '2026-01-02T00:00:00.000Z' }

    expect(sameAgentUsage(a, b)).toBe(true)
    expect(sameAgentUsage(a, { ...b, context: { used: 3, size: 2 } })).toBe(false)
  })

  it('notices a cost that appeared', () => {
    const a = { context: { used: 1, size: 2 }, updatedAt: 'x' }

    expect(sameAgentUsage(a, { ...a, cost: { amount: 1, currency: 'USD' } })).toBe(false)
  })
})
