import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import StatusDot from '~/components/StatusDot.vue'

describe('StatusDot', () => {
  it('labels a known status and animates the ones that mean "busy"', async () => {
    const component = await mountSuspended(StatusDot, { props: { status: 'thinking' } })

    expect(component.text()).toBe('Working')
    expect(component.html()).toContain('animate-pulse')
  })

  it('does not animate a resting status', async () => {
    const component = await mountSuspended(StatusDot, { props: { status: 'idle' } })

    expect(component.text()).toBe('Idle')
    expect(component.html()).not.toContain('animate-pulse')
  })

  it('calls a status it has never heard of idle rather than rendering nothing', async () => {
    const component = await mountSuspended(StatusDot, { props: { status: 'exploded' } })

    expect(component.text()).toBe('Idle')
  })

  it('hands the label to a slot that wants to render it itself', async () => {
    const component = await mountSuspended(StatusDot, {
      props: { status: 'awaiting-permission' },
      slots: { default: (props: { label: string }) => `${props.label}!` }
    })

    expect(component.text()).toBe('Needs you!')
  })
})
