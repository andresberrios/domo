import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import AgentStatusIcon from '~/components/AgentStatusIcon.vue'

/**
 * The tree used to draw every agent as a `StatusDot`. The robot is the same
 * glyph the agent page is headed with, so a row and its page agree; the colour
 * still comes from `AGENT_STATUS_META`, so there is one table of truth.
 */
describe('AgentStatusIcon', () => {
  it('colours and animates a working agent, and keeps the label for a screen reader', async () => {
    const component = await mountSuspended(AgentStatusIcon, { props: { status: 'thinking' } })

    expect(component.html()).toContain('text-primary')
    expect(component.html()).toContain('animate-pulse')
    expect(component.find('.sr-only').text()).toBe('Working')
  })

  it('warns rather than pulses primary when the agent is waiting on a person', async () => {
    const component = await mountSuspended(AgentStatusIcon, { props: { status: 'awaiting-permission' } })

    expect(component.html()).toContain('text-warning')
    expect(component.find('.sr-only').text()).toBe('Needs you')
  })

  it('uses the error colour and does not animate a failed agent', async () => {
    const component = await mountSuspended(AgentStatusIcon, { props: { status: 'error' } })

    expect(component.html()).toContain('text-error')
    expect(component.html()).not.toContain('animate-pulse')
  })

  it('mutes a resting agent', async () => {
    const component = await mountSuspended(AgentStatusIcon, { props: { status: 'idle' } })

    expect(component.html()).toContain('text-dimmed')
    expect(component.html()).not.toContain('animate-pulse')
  })

  it('falls back to idle for a status it has never heard of', async () => {
    const component = await mountSuspended(AgentStatusIcon, { props: { status: 'exploded' } })

    expect(component.find('.sr-only').text()).toBe('Idle')
  })
})
