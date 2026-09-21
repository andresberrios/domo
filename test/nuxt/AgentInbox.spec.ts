import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentInbox from '~/components/AgentInbox.vue'
import { inboxMessage } from '../helpers/events'
import type { AgentInboxMessage } from '~~/shared/types'

// `UTooltip` reads the provider context `UApp` installs, so mount inside one.
const Harness = defineComponent({
  props: { messages: { type: Array as () => AgentInboxMessage[], required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(AgentInbox, { agentSessionId: 'ag_test', messages: props.messages })
  })
})

/**
 * The queue is Domo's, not the adapter's, which is the whole reason it can be
 * shown at all — and the reason a message can be taken back before it goes out.
 */
const deleted = vi.fn()

registerEndpoint('/api/agents/ag_test/inbox/in_gone', {
  method: 'DELETE',
  handler: () => {
    deleted('in_gone')
    return { ok: true, id: 'in_gone' }
  }
})

beforeEach(() => deleted.mockClear())

describe('AgentInbox', () => {
  it('shows what is waiting, and who it came from', async () => {
    const component = await mountSuspended(Harness, {
      props: {
        messages: [
          inboxMessage({ content: [{ type: 'text', text: 'then push it' }], origin: 'user' }),
          inboxMessage({ content: [{ type: 'text', text: 'take the migration' }], origin: 'agent:ag_peer' })
        ]
      }
    })

    expect(component.text()).toContain('2 queued')
    expect(component.text()).toContain('then push it')
    expect(component.text()).toContain('take the migration')
    expect(component.text()).toContain('From you')
    expect(component.text()).toContain('From another agent')
  })

  it('says so rather than showing nothing for an attachment-only message', async () => {
    const component = await mountSuspended(Harness, {
      props: { messages: [inboxMessage({ content: [{ type: 'resource_link', uri: 'file:///tmp/a.png' }] })] }
    })

    expect(component.text()).toContain('(attachments only)')
  })

  it('takes a message back off the queue', async () => {
    const component = await mountSuspended(Harness, {
      props: { messages: [inboxMessage({ id: 'in_gone' })] }
    })

    const remove = component.findAll('button').at(-1)
    await remove!.trigger('click')

    await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith('in_gone'))
  })
})
