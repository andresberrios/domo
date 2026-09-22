import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'

import UsageMeter from '~/components/UsageMeter.vue'
import UsageMeterPanel from '~/components/UsageMeterPanel.vue'
import type { AgentUsage, UsageProviderId, VoiceUsage } from '~~/shared/types'

/**
 * The session chip.
 *
 * Two rules matter more than the layout: with no reading it renders *nothing*
 * rather than a zero (a fresh session has not reported yet, and "0%" would be
 * a claim), and with no context size it shows a token count rather than a
 * percentage of a denominator nobody knows.
 */

const Harness = defineComponent({
  props: {
    usage: { type: Object as () => AgentUsage | VoiceUsage | null, default: null },
    provider: { type: String as () => UsageProviderId | undefined, default: undefined },
  },
  setup: props => () => h(UApp, null, {
    default: () => h(UsageMeter, { usage: props.usage, provider: props.provider })
  })
})

/**
 * The panel is mounted directly rather than through the chip's popover: Reka
 * opens on a pointer sequence happy-dom does not synthesise, and what is worth
 * asserting is the content, not the library's own open/close.
 */
const PanelHarness = defineComponent({
  props: {
    context: { type: Object as () => { used: number, size: number | null }, required: true },
    cost: { type: Object as () => AgentUsage['cost'] | null, default: null },
    provider: { type: String as () => UsageProviderId | undefined, default: undefined }
  },
  setup: props => () => h(UApp, null, {
    default: () => h(UsageMeterPanel, { context: props.context, cost: props.cost, provider: props.provider })
  })
})

const mount = (props: Record<string, unknown>) => mountSuspended(Harness, { props })

describe('UsageMeter', () => {
  it('renders nothing at all when there is no reading', async () => {
    const component = await mount({ usage: null })

    expect(component.text().trim()).toBe('')
  })

  it('shows the context percentage for a session that has reported', async () => {
    const component = await mount({
      usage: { context: { used: 189_200, size: 1_000_000 }, updatedAt: '2026-09-21T12:00:00.000Z' }
    })

    expect(component.text()).toContain('19%')
  })

  it('shows a token count when the context size is unknown', async () => {
    // A Live model Domo has no window for. A made-up denominator would put a
    // meaningless percentage on screen instead.
    const component = await mount({
      usage: { context: { used: 12_345, size: null }, updatedAt: '2026-09-21T12:00:00.000Z' }
    })

    expect(component.text()).toContain('12.3k')
    expect(component.text()).not.toContain('%')
  })

  it('colours the chip by how full it is', async () => {
    const calm = await mount({ usage: { context: { used: 10, size: 100 }, updatedAt: 'x' } })
    expect(calm.html()).not.toContain('text-error')

    const warning = await mount({ usage: { context: { used: 75, size: 100 }, updatedAt: 'x' } })
    expect(warning.html()).toContain('text-warning')

    const spent = await mount({ usage: { context: { used: 95, size: 100 }, updatedAt: 'x' } })
    expect(spent.html()).toContain('text-error')
  })

  it('opens onto the context window, the plan limits and the session cost', async () => {
    const component = await mountSuspended(PanelHarness, {
      props: {
        context: { used: 189_200, size: 1_000_000 },
        cost: { amount: 1.23, currency: 'USD' },
        provider: 'claude'
      }
    })

    expect(component.text()).toContain('Context window')
    expect(component.text()).toContain('189.2k')
    expect(component.text()).toContain('1M')
    expect(component.text()).toContain('(19%)')
    expect(component.text()).toContain('Session cost')
    expect(component.text()).toContain('1.23')
  })

  it('leaves out a section it has no data for', async () => {
    // A voice conversation has no cost and no plan limits behind it.
    const component = await mountSuspended(PanelHarness, {
      props: { context: { used: 1000, size: 10_000 } }
    })

    expect(component.text()).toContain('Context window')
    expect(component.text()).not.toContain('Session cost')
  })

  it('says why there is no bar when the window is unknown', async () => {
    const component = await mountSuspended(PanelHarness, {
      props: { context: { used: 12_345, size: null } }
    })

    expect(component.text()).toContain('12.3k')
    expect(component.text()).toContain('No context size is known')
  })
})
