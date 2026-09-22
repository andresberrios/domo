import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentErrorBanner from '~/components/AgentErrorBanner.vue'
import type { AgentSession } from '~~/shared/types'

/**
 * The banner is the session's *current* state. `lastError` is history — the
 * transcript is where that belongs — so a non-null field on a session that is
 * running again must render nothing.
 */
const started = vi.fn()

registerEndpoint('/api/agents/ag_1/start', {
  method: 'POST',
  handler: () => {
    started()
    return { id: 'ag_1', status: 'idle' }
  }
})

const Harness = defineComponent({
  props: { session: { type: Object as () => AgentSession, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(AgentErrorBanner, { session: props.session })
  })
})

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'ag_1',
    voiceSessionId: null,
    adapter: 'claude-code',
    acpSessionId: 'acp_1',
    title: 'Auth refactor',
    cwd: '/workspaces/domo',
    devEnvironmentId: null,
    status: 'error',
    modeId: null,
    modes: null,
    model: null,
    lastError: 'You\'ve hit your session limit · resets 11pm (UTC)',
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    archived: false,
    ...overrides
  }
}

beforeEach(() => started.mockClear())

describe('AgentErrorBanner', () => {
  it('shows the message and a retry while the session is in error', async () => {
    const component = await mountSuspended(Harness, { props: { session: session() } })

    expect(component.text()).toContain('You\'ve hit your session limit')
    expect(component.text()).toContain('Retry')
  })

  /** The stale case: the error is over, the transcript still has it, the banner is gone. */
  it('renders nothing once the session is running again, however old the error is', async () => {
    const component = await mountSuspended(Harness, {
      props: { session: session({ status: 'idle' }) }
    })

    expect(component.text()).not.toContain('session limit')
    expect(component.find('button').exists()).toBe(false)
  })

  it.each(['thinking', 'idle', 'stopped', 'awaiting-permission'] as const)(
    'stays hidden in %s even with a message left on the row',
    async (status) => {
      const component = await mountSuspended(Harness, { props: { session: session({ status }) } })

      expect(component.text()).not.toContain('session limit')
    }
  )

  it('retries through the start endpoint the rest of the UI uses', async () => {
    const component = await mountSuspended(Harness, { props: { session: session() } })

    await component.find('button').trigger('click')

    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1))
  })

  it('says so when the row is in error with no message at all', async () => {
    const component = await mountSuspended(Harness, { props: { session: session({ lastError: null }) } })

    expect(component.text()).toContain('no details')
  })
})
