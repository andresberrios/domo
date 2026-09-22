import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import UsageLimitRows from '~/components/UsageLimitRows.vue'
import type { UsageLimit, UsageProvider } from '~~/shared/types'

/**
 * The three empty states are the point of this component.
 *
 * "Not configured", "the last check failed" and "nothing yet" call for
 * different things from the reader, and collapsing them into one blank panel is
 * how a misconfigured install looks identical to a working one with nothing to
 * say. A fabricated 0% would be worse than either.
 */

const NOW = Date.parse('2026-09-21T12:00:00.000Z')

const Harness = defineComponent({
  props: {
    limits: { type: Array as () => UsageLimit[], required: true },
    provider: { type: Object as () => UsageProvider | null, default: null }
  },
  setup: props => () => h(UApp, null, {
    default: () => h(UsageLimitRows, { limits: props.limits, provider: props.provider })
  })
})

function limit(patch: Partial<UsageLimit> = {}): UsageLimit {
  return {
    provider: 'claude',
    limitId: 'five_hour',
    label: '5-hour limit',
    usedPercent: 52,
    resetsAt: '2026-09-21T15:41:00.000Z',
    windowMinutes: 300,
    status: null,
    amountUsed: null,
    amountLimit: null,
    currency: null,
    source: 'endpoint',
    updatedAt: '2026-09-21T12:00:00.000Z',
    ...patch
  }
}

const provider = (patch: Partial<UsageProvider> = {}): UsageProvider => ({
  provider: 'claude',
  state: 'ok',
  message: null,
  checkedAt: '2026-09-21T12:00:00.000Z',
  ...patch
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => vi.useRealTimers())

describe('UsageLimitRows', () => {
  it('shows a window with its label, percentage and reset', async () => {
    const component = await mountSuspended(Harness, { props: { limits: [limit()] } })

    expect(component.text()).toContain('5-hour limit')
    expect(component.text()).toContain('52%')
    expect(component.text()).toContain('Resets in 3 hr 41 min')
  })

  it('shows credits as money rather than a share of a window', async () => {
    const component = await mountSuspended(Harness, {
      props: {
        limits: [limit({
          limitId: 'extra_usage',
          label: 'Usage credits',
          usedPercent: 16,
          resetsAt: null,
          amountUsed: 15.95,
          amountLimit: 100,
          currency: 'USD'
        })]
      }
    })

    expect(component.text()).toContain('Usage credits')
    expect(component.text()).toMatch(/\$15\.95.*of.*\$100/)
  })

  it('says a window is spent, whatever the percentage claims', async () => {
    // A window can refuse work below 100% utilization; the row has to say so.
    const component = await mountSuspended(Harness, {
      props: { limits: [limit({ usedPercent: 12, status: 'rejected' })] }
    })

    expect(component.text()).toContain('Limit reached')
  })

  it('names the setting to change when nothing is configured', async () => {
    const component = await mountSuspended(Harness, {
      props: {
        limits: [],
        provider: provider({
          state: 'unconfigured',
          message: 'Set NUXT_CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) to see plan limits.'
        })
      }
    })

    expect(component.text()).toContain('NUXT_CLAUDE_CODE_OAUTH_TOKEN')
    expect(component.text()).not.toContain('0%')
  })

  it('says what broke when the last check failed with nothing to show', async () => {
    const component = await mountSuspended(Harness, {
      props: { limits: [], provider: provider({ state: 'error', message: 'Anthropic rejected the Claude token (HTTP 401).' }) }
    })

    expect(component.text()).toContain('HTTP 401')
  })

  it('keeps the last good numbers when a later check failed, and says so', async () => {
    const component = await mountSuspended(Harness, {
      props: {
        limits: [limit()],
        provider: provider({ state: 'error', message: 'Anthropic is rate-limiting the usage endpoint.' })
      }
    })

    // Stale numbers with a reason beat no numbers at all.
    expect(component.text()).toContain('52%')
    expect(component.text()).toContain('rate-limiting')
  })

  it('says how old a reading is once that matters', async () => {
    const component = await mountSuspended(Harness, {
      props: { limits: [limit({ updatedAt: '2026-09-21T11:48:00.000Z' })] }
    })

    expect(component.text()).toContain('as of 12 min ago')
  })

  it('says nothing about age while the reading is current', async () => {
    const component = await mountSuspended(Harness, { props: { limits: [limit()] } })

    expect(component.text()).not.toContain('as of')
  })

  it('distinguishes "nothing yet" from the other two', async () => {
    const component = await mountSuspended(Harness, {
      props: { limits: [], provider: provider({ state: 'ok' }) }
    })

    expect(component.text()).toContain('No readings yet')
  })

  it('draws no bar for a window with no reading', async () => {
    const component = await mountSuspended(Harness, {
      props: { limits: [limit({ usedPercent: null })] }
    })

    expect(component.text()).toContain('5-hour limit')
    expect(component.text()).not.toContain('0%')
  })
})
