import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it } from 'vitest'

import ActivityGroup from '~/components/ActivityGroup.vue'
import { buildTranscript, condenseTranscript, type ActivityGroup as ActivityGroupItem } from '~/utils/agentTranscript'
import type { AgentEvent } from '~~/shared/types'
import { agentEvent, thoughtChunk } from '../helpers/events'
import { forgetExpandedRows } from '~/composables/useRowOpen'

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
function groupOf(events: AgentEvent[], live = false): ActivityGroupItem {
  const found = condenseTranscript(buildTranscript(events), { live }).find(item => item.kind === 'activity')
  if (!found) throw new Error('these events do not condense into a group')
  return found as ActivityGroupItem
}

function render(events: AgentEvent[], live = false) {
  return mountSuspended(ActivityGroup, { props: { group: groupOf(events, live) } })
}

// Expanded state is kept per id for the whole tab; each case starts collapsed.
beforeEach(() => forgetExpandedRows())

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

  /**
   * A virtual transcript takes a row down when it scrolls out of the window
   * and puts it back on the way in. Opened, it has to come back open — and so
   * the same height the list laid it out at.
   */
  it('is still open when it is drawn again', async () => {
    const events = [
      tool('c1', 'Read', 'completed', { rawInput: { file_path: '/srv/api/src/index.ts' } }),
      tool('c2', 'Bash', 'completed', { rawInput: { command: 'pnpm test --silent' } })
    ]
    const first = await render(events)
    await first.find('button').trigger('click')
    await expect.poll(() => first.text()).toContain('pnpm test --silent')
    first.unmount()

    const again = await render(events)

    await expect.poll(() => again.text()).toContain('pnpm test --silent')
  })

  it('expands thoughts along with the tool calls', async () => {
    const component = await render([
      tool('c1', 'Read'), thoughtChunk('the lockfile is stale'), tool('c2', 'Read')
    ])

    await component.find('button').trigger('click')

    await expect.poll(() => component.text()).toContain('Thought')
  })

  describe('while the run is live', () => {
    it('shows the running call in the header instead of the breakdown', async () => {
      const component = await render([
        tool('c1', 'Read'),
        tool('c2', 'Bash', 'in_progress', { title: 'Run the tests', rawInput: { command: 'pnpm test' } })
      ], true)

      const current = component.find('[data-testid="activity-current"]')
      expect(current.text()).toBe('Run the tests · pnpm test')
      expect(current.find('.animate-spin').exists()).toBe(true)
      expect(component.text()).not.toContain('Read ×1')
    })

    it('says what the agent is thinking when that is the latest thing', async () => {
      const component = await render([
        tool('c1', 'Read'), tool('c2', 'Read'),
        thoughtChunk('the lockfile is stale\nregenerate it')
      ], true)

      expect(component.find('[data-testid="activity-current"]').text()).toBe('Thinking: regenerate it')
    })

    it('goes back to the breakdown once the run is over', async () => {
      const component = await render([tool('c1', 'Read'), tool('c2', 'Bash')])

      expect(component.find('[data-testid="activity-current"]').exists()).toBe(false)
      expect(component.text()).toContain('Read ×1, Bash ×1')
    })
  })

  it('times each item it opens to, in a column of their own', async () => {
    const component = await render([
      tool('c1', 'Read', 'completed', {}), tool('c2', 'Bash')
    ])

    expect(component.findAll('[data-testid="item-time"]')).toHaveLength(0)
    await component.find('button').trigger('click')

    await expect.poll(() => component.findAll('[data-testid="item-time"]').length).toBe(2)
    const times = component.findAll('[data-testid="item-time"]')
    expect(times.every(time => !!time.attributes('datetime') && time.text() !== '')).toBe(true)
  })

  it('leaves the command off the live line on a phone, not the title', async () => {
    const component = await render([
      tool('c1', 'Read'),
      tool('c2', 'Bash', 'in_progress', { title: 'Run the tests', rawInput: { command: 'pnpm test' } })
    ], true)

    const detail = component.find('[data-testid="activity-current"] .hidden')
    expect(detail.text()).toContain('pnpm test')
    expect(detail.classes()).toContain('sm:inline')
  })

  it('names the call itself when it is the only one, not "Bash ×1"', async () => {
    const component = await render([
      tool('c1', 'Bash', 'completed', { title: 'Run the tests', rawInput: { command: 'pnpm test' } }),
      agentEvent('agent_message', { text: 'done', streaming: false })
    ])

    expect(component.find('[data-testid="activity-current"]').text()).toBe('Run the tests · pnpm test')
    expect(component.find('[data-testid="activity-current"] .animate-spin').exists()).toBe(false)
    expect(component.text()).not.toContain('Bash ×1')
  })
  it('says a call once when its title is its command', async () => {
    const component = await render([
      tool('c1', 'Bash', 'completed', { title: 'sleep 2; echo done', rawInput: { command: 'sleep 2; echo done' } }),
      agentEvent('agent_message', { text: 'done', streaming: false })
    ])

    expect(component.find('[data-testid="activity-current"]').text()).toBe('sleep 2; echo done')
  })
})
