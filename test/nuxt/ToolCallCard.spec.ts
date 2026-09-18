import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import ToolCallCard from '~/components/ToolCallCard.vue'
import type { ToolCallView } from '~/utils/agentTranscript'

function tool(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: 'call_1',
    title: 'Bash',
    name: 'Bash',
    kind: 'execute',
    status: 'completed',
    locations: [],
    content: [],
    ...overrides
  }
}

function render(overrides: Partial<ToolCallView> = {}) {
  return mountSuspended(ToolCallCard, { props: { tool: tool(overrides) } })
}

describe('ToolCallCard', () => {
  it('summarises the call in one line', async () => {
    const component = await render({ rawInput: { command: 'pnpm test --silent' } })

    expect(component.text()).toContain('Bash')
    expect(component.text()).toContain('pnpm test --silent')
    expect(component.text()).toContain('Done')
  })

  it.each([
    ['pending', 'Pending'],
    ['in_progress', 'Running'],
    ['completed', 'Done'],
    ['failed', 'Failed']
  ])('labels %s as %s', async (status, label) => {
    const component = await render({ status: status as ToolCallView['status'] })

    expect(component.text()).toContain(label)
  })

  it('shortens a long command instead of pushing the badge off screen', async () => {
    const component = await render({ rawInput: { command: 'x'.repeat(200) } })

    expect(component.text()).toContain('…')
    expect(component.text()).not.toContain('x'.repeat(100))
  })

  it('stays collapsed until it is clicked', async () => {
    const component = await render({
      rawInput: { command: 'pnpm test' },
      content: [{ type: 'content', content: { type: 'text', text: 'all green' } }]
    })

    expect(component.text()).not.toContain('all green')

    await component.find('button').trigger('click')

    await expect.poll(() => component.text()).toContain('all green')
  })

  it('does not pretend to expand when there is nothing to show', async () => {
    const component = await render()

    await component.find('button').trigger('click')

    expect(component.find('button').classes()).toContain('cursor-default')
    expect(component.findAll('.border-t')).toHaveLength(0)
  })

  it('shows the files the call touched, with their line numbers', async () => {
    const component = await render({
      rawInput: { file_path: '/srv/api/src/index.ts' },
      locations: [{ path: '/srv/api/src/index.ts', line: 42 }, { path: '/srv/api/README.md' }]
    })

    await component.find('button').trigger('click')

    expect(component.text()).toContain('…/api/src/index.ts:42')
    expect(component.text()).toContain('…/srv/api/README.md')
  })

  it('renders a diff the tool produced', async () => {
    const component = await render({
      kind: 'edit',
      title: 'Edit',
      content: [{ type: 'diff', path: 'src/index.ts', oldText: 'const a = 1', newText: 'const a = 2' }]
    })

    await component.find('button').trigger('click')

    expect(component.text()).toContain('src/index.ts')
    expect(component.text()).toContain('const a = 2')
  })

  it('names the terminal a command ran in', async () => {
    const component = await render({ content: [{ type: 'terminal', terminalId: 'term_1' }] })

    await component.find('button').trigger('click')

    expect(component.text()).toContain('Ran in terminal term_1')
  })
})
