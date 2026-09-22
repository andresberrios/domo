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

    /**
     * The error belongs to the moment it happened, which is the whole reason
     * the banner does not need to outlive it: it breaks the run of streamed
     * text rather than merging into the bubble above, and it carries the seq
     * and timestamp of its own event.
     */
    it('keeps an error in its own place in the turn that failed', () => {
      const failure = agentEvent('error', { message: 'You\'ve hit your session limit · resets 11pm (UTC)' })
      const items = buildTranscript([textChunk('working on it'), failure, textChunk('continuing')])

      expect(kinds(items)).toEqual(['assistant', 'notice', 'assistant'])
      expect(items[1]).toMatchObject({ tone: 'error', seq: failure.seq, at: failure.createdAt })
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

  describe('coalesced streaming rows', () => {
    const message = (text: string, streaming = false) => agentEvent('agent_message', { text, streaming })
    const thought = (text: string, streaming = false) => agentEvent('agent_thought', { text, streaming })

    it('renders a finished block as one bubble', () => {
      const items = buildTranscript([message('Hello there!')])

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Hello there!', streaming: false })
    })

    it('renders a block that is still filling, so a mid-turn reader sees the text so far', () => {
      const items = buildTranscript([message('Hello th', true)])

      expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Hello th', streaming: true })
    })

    it('keeps its own id, seq and timestamp — the row never moves', () => {
      const row = message('Hello')
      const items = buildTranscript([row])

      expect(items[0]).toMatchObject({ id: row.id, seq: row.seq, at: row.createdAt })
    })

    it('keeps text on either side of a tool call in order and apart', () => {
      const items = buildTranscript([
        message('Let me look.'),
        agentEvent('tool_call', { toolCallId: 'c1', title: 'Read', kind: 'read' }),
        agentEvent('tool_call_update', { toolCallId: 'c1', status: 'completed' }),
        message('Found it.')
      ])

      expect(kinds(items)).toEqual(['assistant', 'tool', 'assistant'])
      expect(items.map(item => (item as any).text ?? '')).toEqual(['Let me look.', '', 'Found it.'])
    })

    it('never merges two blocks, however they sit next to each other', () => {
      const items = buildTranscript([message('one'), message('two'), thought('three')])

      expect(kinds(items)).toEqual(['assistant', 'assistant', 'thought'])
      expect(items.map(item => (item as any).text)).toEqual(['one', 'two', 'three'])
    })

    it('renders a thought block as a thought', () => {
      const items = buildTranscript([thought('weighing the options')])

      expect(items[0]).toMatchObject({ kind: 'thought', text: 'weighing the options' })
    })

    it('ignores a block with no text instead of opening an empty bubble', () => {
      expect(buildTranscript([message(''), agentEvent('agent_message', {})])).toEqual([])
    })
  })

  describe('installs that still hold per-delta rows', () => {
    it('still merges a run of chunks written before the change', () => {
      const items = buildTranscript([textChunk('Hel'), textChunk('lo'), agentEvent('turn_end', {})])

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Hello' })
    })

    it('does not glue a legacy run onto a coalesced block, in either direction', () => {
      const items = buildTranscript([
        textChunk('old '),
        textChunk('style'),
        agentEvent('agent_message', { text: 'new style', streaming: false }),
        textChunk('old again')
      ])

      expect(kinds(items)).toEqual(['assistant', 'assistant', 'assistant'])
      expect(items.map(item => (item as any).text)).toEqual(['old style', 'new style', 'old again'])
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
