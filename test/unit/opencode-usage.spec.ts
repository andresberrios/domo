import { describe, expect, it, vi } from 'vitest'

import { fetchOpenCodeUsage, normalizeOpenCodeUsage } from '../../server/lib/usage/opencode'

/** Captured from a real `GET /zen/go/v1/usage` with a service-account key. */
const CAPTURED = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-09-23T04:57:12.336Z' },
    weekly: { status: 'ok', percent: 0, resetsAt: '2026-09-28T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 0, resetsAt: '2026-10-02T19:07:43.000Z' }
  }
}

const noKey = async () => null

describe('OpenCode Go usage', () => {
  it('reads the shape a real account answers with', () => {
    expect(normalizeOpenCodeUsage(CAPTURED)).toEqual([
      {
        limitId: 'rolling',
        label: '5-hour limit',
        usedPercent: 0,
        resetsAt: '2026-09-23T04:57:12.336Z',
        windowMinutes: 300,
        status: 'allowed',
        amountUsed: null,
        amountLimit: null,
        currency: null,
        source: 'endpoint'
      },
      {
        limitId: 'weekly',
        label: 'Weekly limit',
        usedPercent: 0,
        resetsAt: '2026-09-28T00:00:00.000Z',
        windowMinutes: 10080,
        status: 'allowed',
        amountUsed: null,
        amountLimit: null,
        currency: null,
        source: 'endpoint'
      },
      {
        limitId: 'monthly',
        label: 'Monthly limit',
        usedPercent: 0,
        resetsAt: '2026-10-02T19:07:43.000Z',
        windowMinutes: 43200,
        status: 'allowed',
        amountUsed: null,
        amountLimit: null,
        currency: null,
        source: 'endpoint'
      }
    ])
  })

  it('reads a spent window and a refused one', () => {
    const limits = normalizeOpenCodeUsage({ usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-09-22T20:00:00Z' },
      monthly: { status: 'limited', percent: 100, resetsAt: '2026-10-01T00:00:00Z' }
    } })
    expect(limits.map(limit => [limit.limitId, limit.usedPercent, limit.status]))
      .toEqual([['rolling', 12, 'allowed'], ['monthly', 100, 'rejected']])
  })

  it('says a host login is not enough, because the console rejects it here', async () => {
    // Measured: the device-flow access token answers 401 on this endpoint and a
    // service-account key answers 200, so "logged in" must not read as
    // configured — the message has to send the user somewhere useful.
    const result = await fetchOpenCodeUsage(async () => new Response('{}'), {}, noKey)

    expect(result.outcome).toBe('unconfigured')
    expect(result.message).toContain('service-account key')
  })

  it('uses bearer auth and never includes the key in a failed result', async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer oc_sk_secret' })
      return new Response('no', { status: 401 })
    }) as typeof fetch
    const result = await fetchOpenCodeUsage(request, { NUXT_OPENCODE_API_KEY: 'oc_sk_secret' }, noKey)

    expect(result.outcome).toBe('unconfigured')
    expect(JSON.stringify(result)).not.toContain('oc_sk_secret')
  })

  it('takes the key from Settings when the environment names none', async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer oc_sk_stored' })
      return new Response(JSON.stringify(CAPTURED))
    }) as typeof fetch
    const result = await fetchOpenCodeUsage(request, {}, async () => 'oc_sk_stored')

    expect(result.outcome).toBe('ok')
    expect(result.limits).toHaveLength(3)
  })
})
