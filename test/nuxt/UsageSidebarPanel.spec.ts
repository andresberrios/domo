import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetUsageRefreshForTests } from '~/composables/useUsageRefresh'
import UsageSidebarPanel from '~/components/UsageSidebarPanel.vue'
import type { UsageLimit } from '~~/shared/types'

/**
 * What the sidebar gauge's popover opens onto, mounted directly rather than
 * through the popover: the same reasoning as `UsageMeterPanel.spec.ts`, and
 * what is worth asserting is the content and the refresh, not Reka's own
 * open/close.
 */

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

const limits: UsageLimit[] = [fiveHour]

const entries = [{ id: 'claude' as const, name: 'Claude', limits, provider: null, fiveHour, weekly: null }]

const refreshed = vi.fn()
registerEndpoint('/api/usage/refresh', {
  method: 'POST',
  handler: () => {
    refreshed()
    return { requested: ['claude', 'codex'] }
  }
})

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(UsageSidebarPanel, { entries }) })
})

beforeEach(() => {
  refreshed.mockClear()
  resetUsageRefreshForTests()
})

describe('UsageSidebarPanel', () => {
  it('has a section for the provider, named', async () => {
    const component = await mountSuspended(Harness)

    expect(component.text()).toContain('Plan usage')
    expect(component.text()).toContain('Claude')
    expect(component.text()).toContain('5-hour limit')
  })

  it('asks the server to look again', async () => {
    const component = await mountSuspended(Harness)

    const button = component.findAll('button')
      .find(candidate => candidate.attributes('aria-label') === 'Refresh usage limits')
    expect(button, 'the panel should offer a refresh').toBeTruthy()
    await button!.trigger('click')

    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1))
  })

  it('reports how fresh the two windows it shows are, not the oldest row the provider has ever reported', async () => {
    // Regression: the caption used to be `UsageLimitRows`'s own "oldest row in
    // the set" line, computed over every row the provider has — including a
    // per-model weekly bucket that only the full endpoint call touches, never
    // a manual refresh (which only reaches the header probe). A refresh that
    // had just landed for the 5-hour and weekly windows still read "as of 3 hr
    // ago" because of that unrelated, much staler row sitting in the same list.
    const NOW = Date.parse('2026-09-21T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      const fresh5h: UsageLimit = { ...fiveHour, updatedAt: '2026-09-21T11:57:00.000Z' }
      const freshWeekly: UsageLimit = {
        ...fiveHour,
        limitId: 'seven_day',
        label: 'Weekly · all models',
        windowMinutes: 10080,
        updatedAt: '2026-09-21T11:58:00.000Z'
      }
      const staleOpus: UsageLimit = {
        ...fiveHour,
        limitId: 'seven_day_opus',
        label: 'Weekly · Opus',
        windowMinutes: 10080,
        updatedAt: '2026-09-21T09:00:00.000Z'
      }
      const staleEntries = [{
        id: 'claude' as const,
        name: 'Claude',
        limits: [fresh5h, freshWeekly, staleOpus],
        provider: null,
        fiveHour: fresh5h,
        weekly: freshWeekly
      }]

      const component = await mountSuspended(defineComponent({
        setup: () => () => h(UApp, null, { default: () => h(UsageSidebarPanel, { entries: staleEntries }) })
      }))

      expect(component.text()).toContain('as of 2 min ago')
      expect(component.text()).not.toContain('as of 3 hr ago')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-enables once the server-side floor elapses, instead of staying disabled', async () => {
    // Regression: `canRefresh` used to be a computed comparing against
    // `Date.now()`, which only re-evaluates when a *reactive* dependency
    // changes. `Date.now()` is not one, so it read `false` once and never
    // again — the button looked permanently disabled after the very first
    // refresh, which is nearly always the automatic one on opening the panel.
    vi.useFakeTimers()
    try {
      const component = await mountSuspended(Harness)
      const button = () => component.findAll('button')
        .find(candidate => candidate.attributes('aria-label') === 'Refresh usage limits')!

      await button().trigger('click')
      await vi.advanceTimersByTimeAsync(0)
      expect(refreshed).toHaveBeenCalledTimes(1)
      expect(button().attributes('disabled')).toBeDefined()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(button().attributes('disabled')).toBeUndefined()

      await button().trigger('click')
      await vi.advanceTimersByTimeAsync(0)
      expect(refreshed).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
