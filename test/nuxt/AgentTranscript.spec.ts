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
  lastError: null,
  summary: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: null,
  archived: false
}

function render(events: AgentEvent[], permissions: PendingPermission[] = []) {
  return mountSuspended(AgentTranscript, { props: { session, events, permissions } })
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
})
