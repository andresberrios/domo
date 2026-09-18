import { describe, expect, it } from 'vitest'

import { buildTranscript, type TranscriptItem } from '~/utils/agentTranscript'
import { agentEvent, permission, textChunk, thoughtChunk, userMessage } from '../helpers/events'

/**
 * `buildTranscript()` is the one place where the append-only ACP log becomes
 * something a human looks at. Everything the UI shows depends on it folding
 * correctly, and the folding rules (merge runs of chunks, collapse tool updates
 * onto their call, keep a single plan) are all order-sensitive.
 */

function kinds(items: TranscriptItem[]): string[] {
  return items.map(item => item.kind)
}

describe('buildTranscript', () => {
  it('returns nothing for an empty log', () => {
    expect(buildTranscript([])).toEqual([])
  })

  it('merges a run of message chunks into one bubble', () => {
    const items = buildTranscript([textChunk('Hello '), textChunk('there'), textChunk('!')])

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Hello there!', streaming: true })
  })

  it('keeps the id and timestamp of the chunk that opened the bubble', () => {
    const first = textChunk('one ')
    const items = buildTranscript([first, textChunk('two')])

    expect(items[0]).toMatchObject({ id: first.id, seq: first.seq, at: first.createdAt })
  })

  it('ignores chunks with no text instead of opening an empty bubble', () => {
    const items = buildTranscript([
      agentEvent('agent_message_chunk', { content: { type: 'image', data: '...' } }),
      agentEvent('agent_message_chunk', {})
    ])

    expect(items).toEqual([])
  })

  it('does not merge thoughts into the message above them', () => {
    const items = buildTranscript([
      textChunk('answering'),
      thoughtChunk('hmm '),
      thoughtChunk('maybe'),
      textChunk('back to answering')
    ])

    expect(kinds(items)).toEqual(['assistant', 'thought', 'assistant'])
    expect(items[1]).toMatchObject({ kind: 'thought', text: 'hmm maybe' })
    expect(items[2]).toMatchObject({ kind: 'assistant', text: 'back to answering' })
  })

  it('starts a new bubble after a user message', () => {
    const items = buildTranscript([textChunk('first turn'), userMessage('and now this'), textChunk('second turn')])

    expect(kinds(items)).toEqual(['assistant', 'user', 'assistant'])
  })

  it('splits a user message into text and attachments', () => {
    const items = buildTranscript([
      userMessage('look at this', [
        { type: 'resource_link', name: 'notes.md', uri: 'file:///tmp/notes.md' },
        { type: 'image', uri: 'file:///tmp/shot.png' }
      ])
    ])

    expect(items[0]).toMatchObject({
      kind: 'user',
      text: 'look at this',
      attachments: [
        { name: 'notes.md', uri: 'file:///tmp/notes.md' },
        { name: 'file:///tmp/shot.png', uri: 'file:///tmp/shot.png' }
      ]
    })
  })

  it('joins several text blocks of one user message with newlines', () => {
    const items = buildTranscript([
      agentEvent('user_message', { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    ])

    expect(items[0]).toMatchObject({ kind: 'user', text: 'one\ntwo' })
  })

  describe('tool calls', () => {
    const call = () =>
      agentEvent('tool_call', {
        toolCallId: 'call_1',
        title: 'Bash',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'pnpm test' }
      })

    it('collapses updates onto the original call instead of appending', () => {
      const items = buildTranscript([
        call(),
        agentEvent('tool_call_update', { toolCallId: 'call_1', status: 'in_progress' }),
        agentEvent('tool_call_update', {
          toolCallId: 'call_1',
          status: 'completed',
          rawOutput: { exitCode: 0 },
          content: [{ type: 'content', content: { type: 'text', text: 'ok' } }]
        })
      ])

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        kind: 'tool',
        tool: {
          toolCallId: 'call_1',
          title: 'Bash',
          status: 'completed',
          rawInput: { command: 'pnpm test' },
          rawOutput: { exitCode: 0 }
        }
      })
    })

    it('leaves fields the update did not mention alone', () => {
      const items = buildTranscript([
        call(),
        agentEvent('tool_call_update', { toolCallId: 'call_1', status: 'completed' })
      ])

      expect((items[0] as any).tool).toMatchObject({ title: 'Bash', kind: 'execute' })
    })

    it('drops an update for a call it never saw', () => {
      const items = buildTranscript([
        agentEvent('tool_call_update', { toolCallId: 'never_started', status: 'completed' })
      ])

      expect(items).toEqual([])
    })

    it('falls back to the tool name and sensible defaults', () => {
      const items = buildTranscript([agentEvent('tool_call', { toolCallId: 'call_2', name: 'Read' })])

      expect((items[0] as any).tool).toMatchObject({
        title: 'Read',
        name: 'Read',
        kind: 'other',
        status: 'pending',
        locations: [],
        content: []
      })
    })

    it('ends the streaming bubble so text after a tool call is its own message', () => {
      const items = buildTranscript([textChunk('before'), call(), textChunk('after')])

      expect(kinds(items)).toEqual(['assistant', 'tool', 'assistant'])
    })
  })

  describe('plans', () => {
    const plan = (status: string) =>
      agentEvent('plan', { entries: [{ content: 'Write the test', status, priority: 'high' }] })

    it('keeps one plan and replaces it in place', () => {
      const items = buildTranscript([plan('pending'), plan('in_progress'), plan('completed')])

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        kind: 'plan',
        entries: [{ content: 'Write the test', status: 'completed', priority: 'high' }]
      })
    })

    it('does not split the bubble streaming below it when it updates', () => {
      // A plan update mid-turn used to close the text run and leave two bubbles.
      const items = buildTranscript([plan('pending'), textChunk('working '), plan('in_progress'), textChunk('on it')])

      expect(kinds(items)).toEqual(['plan', 'assistant'])
      expect(items[1]).toMatchObject({ text: 'working on it' })
    })

    it('reads entries from the shapes adapters actually send', () => {
      const entries = [{ content: 'Nested', status: 'pending', priority: 'medium' }]

      expect(buildTranscript([agentEvent('plan_update', { content: { entries } })])[0])
        .toMatchObject({ kind: 'plan', entries })
      expect(buildTranscript([agentEvent('plan', { content: { items: entries } })])[0])
        .toMatchObject({ kind: 'plan', entries })
    })

    it('ignores an empty plan', () => {
      expect(buildTranscript([agentEvent('plan', { entries: [] })])).toEqual([])
    })
  })

  describe('permissions', () => {
    const request = (permissionId: string) =>
      agentEvent('permission_request', {
        permissionId,
        toolCall: { title: 'Write src/index.ts' }
      })

    it('renders a pending request', () => {
      const pending = permission()
      const items = buildTranscript([request(pending.id)], [pending])

      expect(items[0]).toMatchObject({
        kind: 'permission',
        permissionId: pending.id,
        title: 'Write src/index.ts'
      })
    })

    it('drops the request once it has been answered', () => {
      const answered = permission({ resolvedAt: new Date().toISOString(), resolvedOptionId: 'allow' })
      const items = buildTranscript([textChunk('hi'), request(answered.id)], [answered])

      expect(kinds(items)).toEqual(['assistant'])
    })

    it('falls back to a generic title when the tool call is missing', () => {
      const items = buildTranscript([agentEvent('permission_request', { permissionId: 'pm_x' })])

      expect(items[0]).toMatchObject({ kind: 'permission', title: 'Permission needed' })
    })
  })

  describe('notices', () => {
    it('renders errors', () => {
      const items = buildTranscript([agentEvent('error', { message: 'adapter crashed' })])

      expect(items[0]).toMatchObject({ kind: 'notice', tone: 'error', text: 'adapter crashed' })
    })

    it('stays quiet about a turn that ended normally', () => {
      expect(buildTranscript([agentEvent('turn_end', { stopReason: 'end_turn' })])).toEqual([])
    })

    it('reports a turn that ended any other way, in words', () => {
      const items = buildTranscript([agentEvent('turn_end', { stopReason: 'max_tokens' })])

      expect(items[0]).toMatchObject({ kind: 'notice', tone: 'info', text: 'Turn ended: max tokens' })
    })

    it('labels the mesh events agents use to talk to each other', () => {
      const items = buildTranscript([
        agentEvent('mesh_inbound', { from: 'ag_1', fromTitle: 'auth', message: 'take over' }),
        agentEvent('mesh_spawned', { title: 'docs' }),
        agentEvent('adapter-exit', { code: 1 })
      ])

      expect(items.map(item => (item as any).text)).toEqual([
        'Message from agent "auth": take over',
        'Spawned agent "docs"',
        'ACP adapter exited (code 1)'
      ])
    })

    it('ignores event types with nothing to say', () => {
      expect(buildTranscript([agentEvent('available_commands_update', { commands: [] })])).toEqual([])
    })
  })

  it('keeps the whole log in arrival order', () => {
    const items = buildTranscript([
      userMessage('fix the build'),
      thoughtChunk('let me look'),
      textChunk('Checking'),
      agentEvent('tool_call', { toolCallId: 'c1', title: 'Read', kind: 'read' }),
      agentEvent('tool_call_update', { toolCallId: 'c1', status: 'completed' }),
      agentEvent('plan', { entries: [{ content: 'Patch it', status: 'pending', priority: 'high' }] }),
      textChunk('Done.'),
      agentEvent('turn_end', { stopReason: 'end_turn' })
    ])

    expect(kinds(items)).toEqual(['user', 'thought', 'assistant', 'tool', 'plan', 'assistant'])
  })
})
