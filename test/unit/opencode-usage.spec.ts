import { describe, expect, it, vi } from 'vitest'

import { fetchOpenCodeUsage, normalizeOpenCodeUsage, opencodeGoApiKey } from '../../server/lib/usage/opencode'

describe('OpenCode Go usage', () => {
  it('reads the API key from OpenCode auth without exposing the rest', async () => {
    const env = {
      NUXT_OPENCODE_AUTH_CONTENT: JSON.stringify({
        'opencode-go': { type: 'api', key: 'oc-secret' },
        anthropic: { type: 'oauth', access: 'other-secret' }
      })
    }
    await expect(opencodeGoApiKey(env)).resolves.toBe('oc-secret')
  })

  it('normalizes rolling, weekly and monthly windows', () => {
    const limits = normalizeOpenCodeUsage({ usage: {
      rolling: { status: 'ok', percent: 12, resetsAt: '2026-09-22T20:00:00Z' },
      weekly: { status: 'ok', percent: 34, resetsAt: '2026-09-28T00:00:00Z' },
      monthly: { status: 'limited', percent: 100, resetsAt: '2026-10-01T00:00:00Z' }
    } })
    expect(limits.map(limit => [limit.limitId, limit.usedPercent, limit.windowMinutes])).toEqual([
      ['rolling', 12, 300],
      ['weekly', 34, 10080],
      ['monthly', 100, 43200]
    ])
    expect(limits[2]!.status).toBe('rejected')
  })

  it('uses bearer auth and never includes the key in a failed result', async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer oc-secret' })
      return new Response('no', { status: 401 })
    }) as typeof fetch
    const result = await fetchOpenCodeUsage(request, { NUXT_OPENCODE_GO_API_KEY: 'oc-secret' })
    expect(result.outcome).toBe('unconfigured')
    expect(JSON.stringify(result)).not.toContain('oc-secret')
  })
})
