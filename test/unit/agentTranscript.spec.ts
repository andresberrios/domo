import { describe, expect, it } from 'vitest'

import { buildTranscript, condenseTranscript, type MeshItem, type TranscriptItem } from '~/utils/agentTranscript'
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

    it('draws nothing for the notices that used to double every message between agents', () => {
      // An older install wrote one of these beside the tool call that sent the
      // message and the prompt that delivered it; those two are the record.
      const items = buildTranscript([
        agentEvent('mesh_inbound', { from: 'ag_1', fromTitle: 'auth', message: 'take over' }),
        agentEvent('mesh_outbound', { to: 'ag_1', toTitle: 'auth', message: 'take over' }),
        agentEvent('mesh_spawned', { title: 'docs' }),
        agentEvent('mesh_message', { message: 'done' }),
        agentEvent('mesh_permission_answered', { title: 'docs', optionId: 'allow' }),
        agentEvent('adapter-exit', { code: 1 })
      ])

      expect(items.map(item => (item as any).text)).toEqual(['ACP adapter exited (code 1)'])
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

    it('renders nothing at all for a usage_update row', () => {
      // Context occupancy is session state on `agent_sessions.usage`; nothing
      // writes these any more and the schema deletes the ones an older install
      // left behind, but a database the app has not booted on yet still has them.
      const items = buildTranscript([
        userMessage('fix the build'),
        agentEvent('usage_update', { used: 12_000, size: 200_000 }),
        agentEvent('turn_end', { stopReason: 'end_turn' })
      ])

      expect(kinds(items)).toEqual(['user'])
    })

    it('does not split a message a legacy usage_update landed in the middle of', () => {
      // These arrived with every `message_delta`, so on an old install they sit
      // *inside* a run of chunks. Closing the run around one would break the
      // message in two on screen.
      const items = buildTranscript([
        textChunk('Look'),
        agentEvent('usage_update', { used: 10, size: 100 }),
        textChunk('ing at it')
      ])

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Looking at it' })
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

describe('spoken turns', () => {
  it('hides the note and flags the item', () => {
    const items = buildTranscript([
      agentEvent('user_message', { content: [{ type: 'text', text: 'run the tests' }, { type: 'text', text: '[Spoken over voice] Answer for speech.' }] })
    ])

    expect(items[0]).toMatchObject({ kind: 'user', text: 'run the tests', spoken: true })
  })

  it('leaves a typed message unflagged', () => {
    const items = buildTranscript([userMessage('typed')])

    expect(items[0]).toMatchObject({ kind: 'user', text: 'typed', spoken: false })
  })
})

/**
 * One message between agents is one item at each end: the sender's tool call
 * and the receiver's prompt. The payloads below are the shapes the three
 * adapters really produce.
 */
describe('messages between agents', () => {
  const prompt = (text: string, origin?: string) =>
    agentEvent('user_message', { content: [{ type: 'text', text }], ...origin ? { origin } : {} })

  function mesh(items: TranscriptItem[], index = 0): MeshItem {
    const found = items.filter(item => item.kind === 'mesh')[index]
    if (!found) throw new Error('no mesh item at that index')
    return found as MeshItem
  }

  describe('at the receiving end', () => {
    it('reads a message from another agent, without its heading', () => {
      const items = buildTranscript([
        prompt('[Message from agent "auth" (ag_auth1)]\n\ntake over the migration', 'agent:ag_auth1')
      ])

      expect(items).toEqual([expect.objectContaining({
        kind: 'mesh', direction: 'in', via: 'message', peer: { id: 'ag_auth1', title: 'auth' }, text: 'take over the migration', tool: null
      })])
    })

    it('reads a task from the agent that started this one', () => {
      const items = buildTranscript([prompt('Write the README', 'agent:ag_parent')])

      expect(mesh(items)).toMatchObject({ direction: 'in', via: 'spawn', peer: { id: 'ag_parent', title: null }, text: 'Write the README' })
    })

    it('reads a subscription note as news about the agent it is about', () => {
      const items = buildTranscript([
        prompt('Agent Builder (ag_build1) finished its turn (end_turn). Latest output: green', 'system')
      ])

      expect(mesh(items)).toMatchObject({
        via: 'update', peer: { id: 'ag_build1', title: 'Builder' }, text: 'finished its turn (end_turn). Latest output: green'
      })
    })

    it('reads any other note from Domo as from Domo', () => {
      const items = buildTranscript([prompt('Development environment "x" (env_1) is running at /w.', 'system')])

      expect(mesh(items)).toMatchObject({ via: 'domo', peer: { id: null, title: null } })
    })

    it('leaves a person\'s message alone', () => {
      expect(kinds(buildTranscript([prompt('fix the build', 'user')]))).toEqual(['user'])
      expect(kinds(buildTranscript([prompt('fix the build', 'voice')]))).toEqual(['user'])
      expect(kinds(buildTranscript([prompt('fix the build')]))).toEqual(['user'])
    })

    it('recognises messages written before prompts said who sent them', () => {
      const items = buildTranscript([
        prompt('[Message from agent "auth" (ag_auth1)]\n\ntake over'),
        prompt('Agent Builder (ag_build1) stopped with an error: boom.')
      ])

      expect(items.map(item => (item as MeshItem).via)).toEqual(['message', 'update'])
    })

    it('does not take a person writing "Agent …" for a note from Domo', () => {
      expect(kinds(buildTranscript([prompt('Agent Smith (ag_x) is my favourite character')]))).toEqual(['user'])
    })

    it('splits a turn that delivered several queued messages into each one', () => {
      const event = agentEvent('user_message', {
        content: [
          { type: 'text', text: '[From Domo]\n' },
          { type: 'text', text: 'Agent Builder (ag_build1) finished its turn (end_turn).' },
          { type: 'text', text: '\n[Message from agent ag_auth1]\n' },
          { type: 'text', text: '[Message from agent "auth" (ag_auth1)]\n\nlook at this' },
          { type: 'text', text: '\n[From you]\n' },
          { type: 'text', text: 'and push it' }
        ]
      })
      const items = buildTranscript([event])

      expect(kinds(items)).toEqual(['mesh', 'mesh', 'user'])
      expect(items.map(item => item.id)).toEqual([event.id, `${event.id}:1`, `${event.id}:2`])
      expect(mesh(items, 0)).toMatchObject({ via: 'update', peer: { title: 'Builder' } })
      expect(mesh(items, 1)).toMatchObject({ via: 'message', peer: { title: 'auth' }, text: 'look at this' })
      expect(items[2]).toMatchObject({ kind: 'user', text: 'and push it' })
    })
  })

  describe('at the sending end', () => {
    const result = (value: object) => [{ type: 'text', text: JSON.stringify(value) }]

    it('turns Claude Code\'s message_agent call into the message it sent', () => {
      const items = buildTranscript([
        agentEvent('tool_call', { toolCallId: 't1', name: 'mcp__domo__message_agent', title: 'mcp__domo__message_agent', kind: 'other', status: 'pending', rawInput: {} }),
        agentEvent('tool_call_update', { toolCallId: 't1', rawInput: { agentId: 'ag_peer1', message: 'Hello\nthere' } }),
        agentEvent('tool_call_update', { toolCallId: 't1', status: 'completed', rawOutput: result({ delivered: true, agentId: 'ag_peer1', title: 'peer', outcome: 'queued' }) })
      ])

      expect(items).toHaveLength(1)
      expect(mesh(items)).toMatchObject({
        direction: 'out', via: 'message', peer: { id: 'ag_peer1', title: 'peer' }, text: 'Hello\nthere', tool: { status: 'completed' }
      })
    })

    it('is a message from the moment the call starts, before its arguments arrive', () => {
      const items = buildTranscript([
        agentEvent('tool_call', { toolCallId: 't1', name: 'mcp__domo__message_agent', title: 'mcp__domo__message_agent', kind: 'other', status: 'pending', rawInput: {} })
      ])

      expect(mesh(items)).toMatchObject({ via: 'message', peer: { id: null }, text: '', tool: { status: 'pending' } })
    })

    it('reads Codex\'s spawn_agent call', () => {
      const items = buildTranscript([
        agentEvent('tool_call', {
          toolCallId: 'x1',
          title: 'mcp.domo.spawn_agent',
          kind: 'execute',
          status: 'completed',
          rawInput: { server: 'domo', tool: 'spawn_agent', arguments: { title: 'docs', prompt: 'Write the README' } },
          rawOutput: { result: { content: result({ id: 'ag_docs1', title: 'docs' }) } }
        })
      ])

      expect(mesh(items)).toMatchObject({ via: 'spawn', peer: { id: 'ag_docs1', title: 'docs' }, text: 'Write the README' })
    })

    it('reads OpenCode\'s notify_supervisor, which it runs as code', () => {
      const items = buildTranscript([
        agentEvent('tool_call', { toolCallId: 'o1', title: 'execute', kind: 'other', status: 'pending', rawInput: {} }),
        agentEvent('tool_call_update', {
          toolCallId: 'o1',
          status: 'in_progress',
          rawInput: { code: 'await tools.domo.notify_supervisor({ message: "Tests pass, ready to merge", urgent: false })' }
        })
      ])

      expect(mesh(items)).toMatchObject({ via: 'notify', peer: { id: null, title: null }, text: 'Tests pass, ready to merge' })
    })

    it('leaves Domo\'s other tools as tool calls', () => {
      const items = buildTranscript([
        agentEvent('tool_call', { toolCallId: 't1', name: 'mcp__domo__list_agents', title: 'mcp__domo__list_agents', kind: 'other', status: 'completed', rawInput: {} })
      ])

      expect(kinds(items)).toEqual(['tool'])
    })
  })

  it('is never folded into a run of tool activity', () => {
    const tool = (id: string) => agentEvent('tool_call', { toolCallId: id, title: 'Read', name: 'Read', kind: 'read', status: 'completed' })
    const items = condenseTranscript(buildTranscript([
      tool('c1'), tool('c2'),
      agentEvent('tool_call', { toolCallId: 'm1', name: 'mcp__domo__message_agent', title: 'mcp__domo__message_agent', kind: 'other', status: 'completed', rawInput: { agentId: 'ag_p', message: 'hi' } }),
      tool('c3'), tool('c4')
    ]))

    expect(items.map(item => item.kind)).toEqual(['activity', 'mesh', 'activity'])
  })
})
