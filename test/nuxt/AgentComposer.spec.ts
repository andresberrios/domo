import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentComposer from '~/components/AgentComposer.vue'
import type { AgentSession } from '~~/shared/types'

/**
 * The composer is where a person decides what happens to a message sent at an
 * agent that is already working, so the mode has to leave the browser with it.
 */
const sent = vi.fn()

registerEndpoint('/api/agents/ag_1/prompt', {
  method: 'POST',
  handler: async (event) => {
    sent(await readBody(event))
    return { delivery: 'steer', outcome: 'steered' }
  }
})

const Harness = defineComponent({
  props: { session: { type: Object as () => AgentSession, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(AgentComposer, { session: props.session })
  })
})

function session(status: AgentSession['status']): AgentSession {
  return {
    id: 'ag_1',
    voiceSessionId: null,
    adapter: 'claude-code',
    acpSessionId: 'acp_1',
    title: 'Auth refactor',
    cwd: '/workspaces/domo',
    devEnvironmentId: null,
    status,
    modeId: null,
    modes: null,
    model: null,
    lastError: null,
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    archived: false
  }
}

async function type(component: any, text: string) {
  const input = component.find('textarea')
  await input.setValue(text)
  await input.trigger('keydown', { key: 'Enter' })
}

beforeEach(() => sent.mockClear())

describe('AgentComposer', () => {
  it('sends with a delivery mode, and steers by default', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('thinking') } })

    await type(component, 'do the tests first')

    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'do the tests first' }],
      delivery: 'steer'
    }))
  })

  it('offers the choice only while there is a turn to choose about', async () => {
    const idle = await mountSuspended(Harness, { props: { session: session('idle') } })
    expect(idle.text()).not.toContain('Steer')

    const busy = await mountSuspended(Harness, { props: { session: session('thinking') } })
    expect(busy.text()).toContain('Steer')
  })
})
