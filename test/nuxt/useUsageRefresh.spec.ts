import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { refreshIfStale, resetUsageRefreshForTests } from '~/composables/useUsageRefresh'
import UsageLimitRows from '~/components/UsageLimitRows.vue'
import type { UsageLimit } from '~~/shared/types'

/**
 * Opening a usage view asks the server for a fresher reading if its own is
 * old. The server decides; the client only keeps a burst of views (the
 * sidebar's sections, the composer's popover, a second tab of the same page)
 * from asking more than once.
 */

const asks: Array<{ provider?: string, ifStale?: boolean }> = []
let hold: Promise<void> | null = null
registerEndpoint('/api/usage/refresh', {
  method: 'POST',
  handler: async (event) => {
    asks.push(await readBody(event))
    if (hold) await hold
    return { requested: ['claude'] }
  }
})

const fiveHour: UsageLimit = {
  provider: 'claude',
  limitId: 'five_hour',
  label: '5-hour limit',
  usedPercent: 50,
  resetsAt: null,
  windowMinutes: 300,
  status: null,
  amountUsed: null,
  amountLimit: null,
  currency: null,
  source: 'headers',
  updatedAt: '2026-09-21T12:00:00.000Z'
}

beforeEach(() => {
  asks.length = 0
  hold = null
  resetUsageRefreshForTests()
})

describe('refreshIfStale', () => {
  it('sends one request while one is in flight, whoever asks', async () => {
    let release!: () => void
    hold = new Promise((resolve) => { release = resolve })
    const all = Promise.all([refreshIfStale('claude'), refreshIfStale('claude'), refreshIfStale('claude')])
    await vi.waitFor(() => expect(asks).toHaveLength(1))
    release()
    await all

    expect(asks).toEqual([{ provider: 'claude', ifStale: true }])
  })

  it('does not ask again inside the minute, but asks for another provider', async () => {
    await refreshIfStale('claude')
    await refreshIfStale('claude')
    await refreshIfStale('codex')

    expect(asks.map(ask => ask.provider)).toEqual(['claude', 'codex'])
  })

  it('asks again once the minute has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await refreshIfStale('claude')
      vi.setSystemTime(Date.now() + 61_000)
      await refreshIfStale('claude')
      expect(asks).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is what a usage view does when it opens', async () => {
    await mountSuspended(defineComponent({
      setup: () => () => h(UApp, null, { default: () => h(UsageLimitRows, { limits: [fiveHour] }) })
    }))

    await vi.waitFor(() => expect(asks).toEqual([{ provider: 'claude', ifStale: true }]))
  })
})
