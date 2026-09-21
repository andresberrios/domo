import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import ActivityGroup from '~/components/ActivityGroup.vue'
import { buildTranscript, condenseTranscript, type ActivityGroup as ActivityGroupItem } from '~/utils/agentTranscript'
import type { AgentEvent } from '~~/shared/types'
import { agentEvent, thoughtChunk } from '../helpers/events'

const tool = (id: string, name: string, status = 'completed', payload: any = {}) =>
  agentEvent('tool_call', {
    toolCallId: id,
    title: name,
    name,
    kind: name === 'Bash' ? 'execute' : 'read',
    status,
    ...payload
  })

/** Build a real group the only way the app ever does: out of the two passes. */
function groupOf(events: AgentEvent[]): ActivityGroupItem {
  const found = condenseTranscript(buildTranscript(events)).find(item => item.kind === 'activity')
  if (!found) throw new Error('these events do not condense into a group')
  return found as ActivityGroupItem
}

function render(events: AgentEvent[]) {
  return mountSuspended(ActivityGroup, { props: { group: groupOf(events) } })
}

describe('ActivityGroup', () => {
  it('sums the run up in one line', async () => {
    const component = await render([
      tool('c1', 'Read'), tool('c2', 'Read'), tool('c3', 'Bash'),
      thoughtChunk('that is the wrong file'),
      tool('c4', 'Read')
    ])

    expect(component.text()).toContain('4 tool calls · 1 thought')
  })

  it('breaks the run down by tool, most frequent first', async () => {
    const component = await render([
      tool('c1', 'Read'), tool('c2', 'Read'), tool('c3', 'Read'),
      tool('c4', 'Bash'), tool('c5', 'Bash'),
      tool('c6', 'Edit')
    ])

    expect(component.text()).toContain('Read ×3, Bash ×2, Edit ×1')
  })

  it('calls out the calls that failed', async () => {
    const component = await render([
      tool('c1', 'Bash', 'failed'), tool('c2', 'Bash', 'completed'), tool('c3', 'Bash', 'failed')
    ])

    expect(component.text()).toContain('2 failed')
  })

  it('says nothing about failures when there were none', async () => {
    const component = await render([tool('c1', 'Read'), tool('c2', 'Read')])

    expect(component.text()).not.toContain('failed')
  })

  it('hides the cards until it is clicked, and hides them again', async () => {
    const component = await render([
      tool('c1', 'Read', 'completed', { rawInput: { file_path: '/srv/api/src/index.ts' } }),
      tool('c2', 'Bash', 'completed', { rawInput: { command: 'pnpm test --silent' } })
    ])

    expect(component.text()).not.toContain('pnpm test --silent')

    await component.find('button').trigger('click')
    await expect.poll(() => component.text()).toContain('pnpm test --silent')
    expect(component.text()).toContain('Done')

    await component.find('button').trigger('click')
    await expect.poll(() => component.text()).not.toContain('pnpm test --silent')
  })

  it('expands thoughts along with the tool calls', async () => {
    const component = await render([
      tool('c1', 'Read'), thoughtChunk('the lockfile is stale'), tool('c2', 'Read')
    ])

    await component.find('button').trigger('click')

    await expect.poll(() => component.text()).toContain('Thought')
  })
})
