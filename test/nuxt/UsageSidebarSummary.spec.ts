import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp, UPopover } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('asks the server to look again as soon as the panel opens', async () => {
    const component = await mountSuspended(Harness)

    // Reka opens on a pointer sequence happy-dom does not synthesise (see
    // `UsageMeter.spec.ts`), so the popover's own `update:open` event drives
    // this directly rather than a click on its trigger.
    await component.findComponent(UPopover).vm.$emit('update:open', true)

    await vi.waitFor(() => expect(calls).toHaveLength(1))
  })

  it('does not repeat the request if the panel is closed and reopened moments later', async () => {
    // The server's own floor (one request a minute per provider) silently
    // drops a second request inside the window rather than erroring, so a
    // client that fired one anyway would look like it refreshed and would not
    // have. `useUsageRefresh`'s shared cooldown is what stops that.
    const component = await mountSuspended(Harness)
    const popover = component.findComponent(UPopover)

    await popover.vm.$emit('update:open', true)
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    await popover.vm.$emit('update:open', false)
    await popover.vm.$emit('update:open', true)
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(calls).toHaveLength(1)
  })
})
