import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp, UDropdownMenu } from '#components'
import { defineComponent, h } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentInbox from '~/components/AgentInbox.vue'
import { inboxMessage } from '../helpers/events'
import { readBody } from 'h3'
import type { AgentInboxMessage, AgentSession, QueuedDeliveryResult } from '~~/shared/types'

// `UTooltip` reads the provider context `UApp` installs, so mount inside one.
const Harness = defineComponent({
  props: {
    messages: { type: Array as () => AgentInboxMessage[], required: true },
    session: { type: Object as () => AgentSession | null, default: null }
  },
  setup: props => () => h(UApp, null, {
    default: () => h(AgentInbox, { agentSessionId: 'ag_test', messages: props.messages, session: props.session })
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

/** "Send now": what the server was asked for, and what it answers. */
const delivered = vi.fn()
let answer: QueuedDeliveryResult = { delivery: 'steer', delivered: 1, waiting: 0 }

registerEndpoint('/api/agents/ag_test/inbox/deliver', {
  method: 'POST',
  handler: async (event) => {
    delivered(await readBody(event))
    return answer
  }
})

const working = (overrides: Partial<AgentSession> = {}) => ({ id: 'ag_test', status: 'thinking', steering: true, ...overrides }) as AgentSession

beforeEach(() => {
  deleted.mockClear()
  delivered.mockClear()
  answer = { delivery: 'steer', delivered: 1, waiting: 0 }
})

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

  it('sends what is queued into the running turn by default', async () => {
    const component = await mountSuspended(Harness, { props: { messages: [inboxMessage()], session: working() } })

    const send = component.findAll('button').find(button => button.text() === 'Send now')!
    await send.trigger('click')

    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith({ delivery: 'steer' }))
  })

  it('cancels the turn first when interrupt is chosen', async () => {
    const component = await mountSuspended(Harness, { props: { messages: [inboxMessage()], session: working() } })

    const items = (component.findComponent(UDropdownMenu) as any).props('items') as any[][]
    items[0]!.find(item => item.label === 'Interrupt')!.onUpdateChecked()
    await component.vm.$nextTick()
    await component.findAll('button').find(button => button.text() === 'Send now')!.trigger('click')

    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith({ delivery: 'interrupt' }))
  })

  it('says a steer will stop the turn on an agent that cannot take one mid-turn', async () => {
    const component = await mountSuspended(Harness, { props: { messages: [inboxMessage()], session: working({ steering: false }) } })

    const items = (component.findComponent(UDropdownMenu) as any).props('items') as any[][]
    expect(items[0]!.find(item => item.label === 'Steer')!.description).toContain('stops the current turn')
  })

  it('has no mode to choose with no turn running, and none to send at all when read only', async () => {
    const idle = await mountSuspended(Harness, { props: { messages: [inboxMessage()], session: working({ status: 'idle' }) } })
    expect(idle.findComponent(UDropdownMenu).exists()).toBe(false)
    expect(idle.text()).toContain('Send now')

    const record = await mountSuspended(Harness, { props: { messages: [inboxMessage()] } })
    expect(record.text()).not.toContain('Send now')
  })

  it('says how many are still waiting when the agent stopped taking them part way', async () => {
    answer = { delivery: 'steer', delivered: 1, waiting: 2 }
    const component = await mountSuspended(Harness, { props: { messages: [inboxMessage(), inboxMessage(), inboxMessage()], session: working() } })

    await component.findAll('button').find(button => button.text() === 'Send now')!.trigger('click')

    await vi.waitFor(() => expect(document.body.textContent).toContain('1 joined the turn; 2 still queued'))
  })
})
