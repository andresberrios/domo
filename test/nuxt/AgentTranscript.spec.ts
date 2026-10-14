import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'

import AgentTranscript from '~/components/AgentTranscript.vue'
import type { AgentEvent, AgentSession, PendingPermission } from '~~/shared/types'
import { agentEvent, permission, textChunk, thoughtChunk, userMessage } from '../helpers/events'

const session: AgentSession = {
  id: 'ag_1',
  voiceSessionId: null,
  adapter: 'claude-code',
  acpSessionId: 'acp_1',
  title: 'Auth refactor',
  cwd: '/srv/api',
  devEnvironmentId: null,
  status: 'idle',
  modeId: 'default',
  modes: null,
  model: null,
  config: null,
  configOptions: null,
  steering: null,
  lastError: null,
  summary: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: null,
  archived: false,
  usage: null,
  spawnedBy: null
}

function render(events: AgentEvent[], permissions: PendingPermission[] = [], condensed = false) {
  return mountSuspended(AgentTranscript, { props: { session, events, permissions, condensed } })
}

/** MarkdownView renders asynchronously (Shiki), so message bodies land a tick late. */
function text(component: Awaited<ReturnType<typeof render>>) {
  return expect.poll(() => component.text())
}

describe('AgentTranscript', () => {
  /**
   * UChatMessages skips a message whose `parts` array is empty, so every item —
   * including the ones that only render through the `#content` slot — needs a
   * plain-text part. Losing that is silent: the item simply never appears.
   */
  it('gives every kind of item a plain-text part so none of them is skipped', async () => {
    const pending = permission()
    const component = await render([
      userMessage('fix the build'),
      textChunk('Looking at it.'),
      thoughtChunk('the lockfile is stale'),
      agentEvent('tool_call', { toolCallId: 'c1', title: 'Bash', kind: 'execute' }),
      agentEvent('plan', { entries: [{ content: 'Refresh the lockfile', status: 'pending', priority: 'high' }] }),
      agentEvent('permission_request', { permissionId: pending.id, toolCall: { title: 'Run pnpm install' } }),
      agentEvent('error', { message: 'adapter crashed' })
    ], [pending])

    await text(component).toContain('fix the build')
    await text(component).toContain('Looking at it.')
    await text(component).toContain('Thought')
    await text(component).toContain('Bash')
    await text(component).toContain('Refresh the lockfile')
    await text(component).toContain('Run pnpm install')
    await text(component).toContain('adapter crashed')
  })

  /**
   * The transcript is where an error lives on after the session has recovered
   * (the banner keys on `status` and goes), so it has to stay visible, in
   * error tone, at the point in the turn where it happened — a message of its
   * own between the text before it and the text after, never folded into
   * either. There is no condensed/uncondensed switch in this component: it
   * renders one item per transcript item and nothing groups them, so "outside
   * any activity group" is the only mode there is.
   */
  it('renders an error as its own error-toned notice, between the text around it', async () => {
    const component = await render([
      textChunk('working on it'),
      agentEvent('error', { message: 'You\'ve hit your session limit · resets 11pm (UTC)' }),
      textChunk('continuing')
    ])

    await text(component).toContain('You\'ve hit your session limit')
    const notice = component.find('.text-error')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toBe('You\'ve hit your session limit · resets 11pm (UTC)')
    // Three items, not a bubble that swallowed the error.
    expect(component.findAll('[data-role="assistant"]')).toHaveLength(3)
  })

  it('separates the user\'s messages from the agent\'s', async () => {
    const component = await render([userMessage('fix the build'), textChunk('on it')])

    await text(component).toContain('fix the build')
    expect(component.find('[data-role="user"]').exists()).toBe(true)
    expect(component.find('[data-role="assistant"]').exists()).toBe(true)
  })

  it('renders assistant markdown rather than the raw source', async () => {
    const component = await render([textChunk('**bold** and `code`')])

    await expect.poll(() => component.html()).toContain('<strong>bold</strong>')
    expect(component.html()).toContain('<code>code</code>')
  })

  it('lists the attachments of a user message', async () => {
    const component = await render([
      userMessage('have a look', [{ type: 'resource_link', name: 'notes.md', uri: 'file:///tmp/notes.md' }])
    ])

    await text(component).toContain('notes.md')
  })

  it('shows a plan with its progress', async () => {
    const component = await render([
      agentEvent('plan', {
        entries: [
          { content: 'Read the config', status: 'completed', priority: 'high' },
          { content: 'Fix the test', status: 'pending', priority: 'high' }
        ]
      })
    ])

    await text(component).toContain('Plan')
    expect(component.text()).toContain('1/2')
  })

  it('drops a permission marker as soon as the request is answered', async () => {
    const answered = permission({ resolvedAt: '2026-01-01T00:00:01.000Z', resolvedOptionId: 'allow' })
    const events = [agentEvent('permission_request', { permissionId: answered.id, toolCall: { title: 'Run tests' } })]

    const pendingView = await render(events, [permission({ ...answered, resolvedAt: null })])
    expect(pendingView.text()).toContain('Waiting for permission')

    const answeredView = await render(events, [answered])
    expect(answeredView.text()).not.toContain('Waiting for permission')
  })

  it.each([
    ['thinking', 'streaming'],
    ['starting', 'streaming'],
    ['idle', 'ready'],
    ['error', 'ready']
  ])('reports %s as a %s transcript', async (status, expected) => {
    const component = await mountSuspended(AgentTranscript, {
      props: { session: { ...session, status: status as AgentSession['status'] }, events: [textChunk('…')], permissions: [] }
    })

    expect(component.find(`[data-status="${expected}"]`).exists()).toBe(true)
  })

  it('renders an empty transcript without falling over', async () => {
    const component = await render([])

    expect(component.text().trim()).toBe('')
  })

  /**
   * Condensing is a render choice, not a change to the log: the same events
   * draw as one row or as every card, and the things the user has to act on
   * stay on screen either way.
   */
  describe('condensed', () => {
    const toolCall = (id: string, name: string) =>
      agentEvent('tool_call', { toolCallId: id, title: name, name, kind: 'execute', status: 'completed' })

    const run = [
      toolCall('c1', 'Read'),
      toolCall('c2', 'Read'),
      toolCall('c3', 'Bash'),
      agentEvent('agent_message', { text: 'All set.', streaming: false })
    ]

    it('draws a run as one row and none of its cards', async () => {
      const component = await render(run, [], true)

      await text(component).toContain('3 tool calls')
      expect(component.text()).toContain('Read ×2, Bash ×1')
      expect(component.findAllComponents({ name: 'ToolCallCard' })).toHaveLength(0)
      await text(component).toContain('All set.')
    })

    it('draws every card when it is off', async () => {
      const component = await render(run, [], false)

      await text(component).toContain('Read')
      expect(component.text()).not.toContain('3 tool calls')
      expect(component.findAllComponents({ name: 'ToolCallCard' })).toHaveLength(3)
    })

    it('is on unless the page says otherwise', async () => {
      const component = await mountSuspended(AgentTranscript, {
        props: { session, events: run, permissions: [] }
      })

      await text(component).toContain('3 tool calls')
    })

    it('never hides a permission that is still waiting for an answer', async () => {
      const pending = permission()
      const component = await render([
        toolCall('c1', 'Read'),
        toolCall('c2', 'Read'),
        agentEvent('permission_request', { permissionId: pending.id, toolCall: { title: 'Run pnpm install' } }),
        toolCall('c3', 'Bash'),
        toolCall('c4', 'Bash')
      ], [pending], true)

      await text(component).toContain('Waiting for permission: Run pnpm install')
      expect(component.text()).toContain('2 tool calls')
    })

    it('draws the call that is running now inside its group, in the header', async () => {
      const component = await render([
        toolCall('c1', 'Read'),
        toolCall('c2', 'Read'),
        agentEvent('tool_call', { toolCallId: 'c3', title: 'Bash', name: 'Bash', kind: 'execute', status: 'in_progress' })
      ], [], true)

      await text(component).toContain('3 tool calls')
      expect(component.findAllComponents({ name: 'ToolCallCard' })).toHaveLength(0)
      expect(component.find('[data-testid="activity-current"]').text()).toBe('Bash')
    })
  })

  describe('times', () => {
    const at = (iso: string) => ({ createdAt: iso })
    const said = (text: string, iso: string) => agentEvent('user_message', { content: [{ type: 'text', text }] }, at(iso))
    const day1 = '2026-03-02T10:00:00.000Z'
    const day1Later = '2026-03-02T10:05:00.000Z'
    const day2 = '2026-03-04T10:00:00.000Z'

    it('puts a time on every row, with the whole instant on hover', async () => {
      const component = await render([
        said('fix the build', day1),
        agentEvent('agent_message', { text: 'On it.', streaming: false }, at(day1Later)),
        agentEvent('error', { message: 'adapter crashed' }, at(day1Later))
      ])

      const times = component.findAll('[data-testid="row-time"]')
      expect(times).toHaveLength(3)
      expect(times.map(time => time.attributes('datetime'))).toEqual([day1, day1Later, day1Later])
      expect(times.every(time => time.text() !== '' && !!time.attributes('title'))).toBe(true)
    })

    it('names the day above the first row of each day, and only there', async () => {
      const component = await render([
        said('first', day1),
        agentEvent('agent_message', { text: 'one', streaming: false }, at(day1Later)),
        said('next', day2),
        agentEvent('agent_message', { text: 'two', streaming: false }, at(day2))
      ])

      const days = component.findAll('[data-testid="day-separator"]')
      expect(days).toHaveLength(2)
      expect(days.map(day => day.find('time').attributes('datetime'))).toEqual([day1, day2])
    })
  })
})
