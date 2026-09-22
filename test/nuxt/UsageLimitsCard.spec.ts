import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import UsageLimitsCard from '~/components/UsageLimitsCard.vue'

/**
 * The account-wide card.
 *
 * Refreshing is fire-and-forget: the endpoint places the request and the rows
 * arrive through Electric, so there is nothing to await and nothing to merge.
 * What this pins is that the button actually reaches the endpoint — the part
 * that would fail silently.
 */

const refreshed = vi.fn()

registerEndpoint('/api/usage/refresh', {
  method: 'POST',
  handler: () => {
    refreshed()
    return { requested: ['claude', 'codex'] }
  }
})

const Harness = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(UsageLimitsCard) })
})

beforeEach(() => refreshed.mockClear())

describe('UsageLimitsCard', () => {
  it('has a section for each account, named', async () => {
    const component = await mountSuspended(Harness)

    expect(component.text()).toContain('Plan usage')
    expect(component.text()).toContain('Claude')
    expect(component.text()).toContain('Codex')
  })

  it('asks the server to look again', async () => {
    const component = await mountSuspended(Harness)

    const button = component.findAll('button')
      .find(candidate => candidate.attributes('aria-label') === 'Refresh usage limits')
    expect(button, 'the card should offer a refresh').toBeTruthy()
    await button!.trigger('click')

    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1))
  })
})
