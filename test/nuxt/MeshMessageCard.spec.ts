import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import MeshMessageCard from '~/components/MeshMessageCard.vue'
import type { MeshItem } from '~/utils/agentTranscript'

function item(overrides: Partial<MeshItem> = {}): MeshItem {
  return {
    id: 'ev_1',
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    kind: 'mesh',
    direction: 'in',
    via: 'message',
    peer: { id: 'ag_auth1', title: 'auth' },
    text: 'Take over the migration.\n\nThe schema is in db.ts.',
    tool: null,
    ...overrides
  }
}

function render(overrides: Partial<MeshItem> = {}) {
  return mountSuspended(MeshMessageCard, { props: { item: item(overrides) } })
}

describe('MeshMessageCard', () => {
  it.each([
    [{ direction: 'in', via: 'message' }, 'From auth'],
    [{ direction: 'out', via: 'message' }, 'To auth'],
    [{ direction: 'out', via: 'spawn' }, 'Started auth'],
    [{ direction: 'in', via: 'spawn' }, 'Task from auth'],
    [{ direction: 'out', via: 'notify', peer: { id: null, title: null } }, 'To you'],
    [{ direction: 'in', via: 'domo', peer: { id: null, title: null } }, 'From Domo'],
    [{ direction: 'in', via: 'update' }, 'auth']
  ] as const)('heads %o as "%s"', async (overrides, heading) => {
    const component = await render(overrides as Partial<MeshItem>)

    expect(component.find('.font-medium').text()).toBe(heading)
  })

  it('starts as one line, with the message flattened into a preview', async () => {
    const component = await render()

    expect(component.find('button').text()).toContain('Take over the migration. The schema is in db.ts.')
    expect(component.find('a').exists()).toBe(false)
  })

  it('opens to the whole message and a way to the other agent', async () => {
    const component = await render()

    await component.find('button').trigger('click')

    await expect.poll(() => component.find('a').exists()).toBe(true)
    expect(component.find('a').attributes('href')).toBe('/agents/ag_auth1')
    expect(component.find('a').text()).toContain('Open auth')
  })

  it('says how a message it sent was delivered', async () => {
    const component = await render({
      direction: 'out',
      tool: {
        toolCallId: 't1',
        title: 'mcp__domo__message_agent',
        name: 'mcp__domo__message_agent',
        kind: 'other',
        status: 'completed',
        locations: [],
        content: [],
        rawInput: { agentId: 'ag_auth1', message: 'hi' },
        rawOutput: [{ type: 'text', text: '{"delivered":true,"outcome":"queued"}' }]
      }
    })
    expect(component.text()).not.toContain('Sending')

    await component.find('button').trigger('click')

    await expect.poll(() => component.text()).toContain('Queued until its turn ends')
  })

  it('shows that it is still sending', async () => {
    const component = await render({
      direction: 'out',
      tool: { toolCallId: 't1', title: 'mcp__domo__message_agent', name: 'mcp__domo__message_agent', kind: 'other', status: 'in_progress', locations: [], content: [] }
    })

    expect(component.text()).toContain('Sending')
  })
})
