import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetUsageRefreshForTests } from '~/composables/useUsageRefresh'
import UsageSidebarSummary from '~/components/UsageSidebarSummary.vue'
import type { UsageLimit, UsageProvider, UsageProviderId } from '~~/shared/types'

/**
 * The sidebar footer's gauge.
 *
 * The manual refresh button itself is `UsageSidebarPanel`'s own concern
 * (`UsageSidebarPanel.spec.ts`) — Reka teleports the popover's content to
 * `document.body` and re-renders it once floating-ui settles its position, so
 * asserting on a button inside it here would mean chasing a moving DOM node
 * for no benefit. What belongs to this component is that both windows show up
 * with no click, and that opening the popover asks the server to look again.
 */

const CLAUDE_LIMITS: UsageLimit[] = [
  {
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
  },
  {
    provider: 'claude',
    limitId: 'seven_day',
    label: 'Weekly · all models',
    usedPercent: 67,
    resetsAt: null,
    windowMinutes: 10080,
    status: null,
    amountUsed: null,
    amountLimit: null,
    currency: null,
    source: 'headers',
    updatedAt: '2026-09-21T12:00:00.000Z'
  }
]

mockNuxtImport('useUsageLimits', () => () => ({
  forProvider: (id: UsageProviderId) => (id === 'claude' ? CLAUDE_LIMITS : []),
  providerState: (id: UsageProviderId): UsageProvider | null =>
    id === 'claude' ? { provider: 'claude', state: 'ok', message: null, checkedAt: '2026-09-21T12:00:00.000Z' } : null
}))

const calls: string[] = []
registerEndpoint('/api/usage/refresh', {
  method: 'POST',
  handler: () => {
    calls.push('refresh')
    return { requested: ['claude', 'codex'] }
  }
})

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(UsageSidebarSummary) })
})

beforeEach(() => {
  calls.length = 0
  resetUsageRefreshForTests()
})

describe('UsageSidebarSummary', () => {
  it('shows the 5-hour and weekly windows as gauges, without needing a click', async () => {
    const component = await mountSuspended(Harness)

    // Named by their `title`, the way `UsageLimitGauge` labels the icon+bar
    // it draws in place of a plain-text "5h"/"wk".
    expect(component.html()).toContain('title="5-hour limit: 50%"')
    expect(component.html()).toContain('title="Weekly limit: 67%"')
    expect(component.text()).toContain('50%')
    expect(component.text()).toContain('67%')
  })

  it('gives every bar one length whatever its percentage, in columns after the names', async () => {
    const component = await mountSuspended(Harness)

    const gauges = component.findAll('[title^="5-hour limit"], [title^="Weekly limit"]')
    expect(gauges).toHaveLength(2)
    for (const gauge of gauges) {
      // The percentage takes a fixed width, so the bar beside it does not
      // grow or shrink with its digits; only the bar grows into the cell.
      const [, bar, percent] = gauge.element.children
      expect(percent!.className).toMatch(/\bw-\[4ch\]/)
      expect(percent!.className).toMatch(/\bshrink-0\b/)
      expect(bar!.className).toMatch(/\bflex-1\b/)
    }

    // One grid: the names, then two equal gauge columns with a gap between.
    const grid = gauges[0]!.element.parentElement!
    expect(grid.className).toContain('grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]')
    expect(grid.className).toMatch(/\bgap-x-\d/)
    expect(grid.className).toContain('text-start')
    expect(grid.children[0]!.textContent).toBe('Claude')
  })
})

