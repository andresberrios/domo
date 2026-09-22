import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import EnvironmentIcon from '~/components/EnvironmentIcon.vue'

/**
 * The bug this replaced: environments were drawn with an agent `StatusDot`,
 * which has no `running` state, so `running` fell through to the neutral dot
 * and a live container looked switched off.
 */
describe('EnvironmentIcon', () => {
  it('lights up a running environment', async () => {
    const component = await mountSuspended(EnvironmentIcon, { props: { status: 'running' } })

    expect(component.html()).toContain('text-primary')
    expect(component.html()).not.toContain('animate-pulse')
    expect(component.find('.sr-only').text()).toBe('Running')
  })

  it('dims a stopped one', async () => {
    const component = await mountSuspended(EnvironmentIcon, { props: { status: 'stopped' } })

    expect(component.html()).toContain('text-dimmed')
    expect(component.find('.sr-only').text()).toBe('Stopped')
  })

  it('warns, and pulses, while one is being built', async () => {
    const component = await mountSuspended(EnvironmentIcon, { props: { status: 'creating' } })

    expect(component.html()).toContain('text-warning')
    expect(component.html()).toContain('animate-pulse')
    expect(component.find('.sr-only').text()).toBe('Creating')
  })

  it('uses the error colour for one that failed', async () => {
    const component = await mountSuspended(EnvironmentIcon, { props: { status: 'error' } })

    expect(component.html()).toContain('text-error')
    expect(component.find('.sr-only').text()).toBe('Error')
  })

  it('falls back to stopped rather than rendering nothing', async () => {
    const component = await mountSuspended(EnvironmentIcon, { props: { status: 'melted' } })

    expect(component.find('.sr-only').text()).toBe('Stopped')
  })
})
