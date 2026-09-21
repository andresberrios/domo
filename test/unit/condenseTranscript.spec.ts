import { describe, expect, it } from 'vitest'

import {
  activityBreakdown,
  activityLabel,
  buildTranscript,
  condenseTranscript,
  type ActivityGroup,
  type CondensedItem
} from '~/utils/agentTranscript'
import { agentEvent, permission, textChunk, thoughtChunk, userMessage } from '../helpers/events'

/**
 * The second pass over the transcript. `buildTranscript()` decides what
 * happened; this one only decides what to draw, so it must never invent, drop
 * or reorder an item — and it must never hide the two things the user has to
 * act on: a pending permission and whatever the agent is doing right now.
 */

function kinds(items: CondensedItem[]): string[] {
  return items.map(item => item.kind)
}

function group(items: CondensedItem[], index = 0): ActivityGroup {
  const found = items.filter(item => item.kind === 'activity')[index]
  if (!found) throw new Error('no activity group at that index')
  return found as ActivityGroup
}

const tool = (
  toolCallId: string,
  name = 'Read',
  status: string = 'completed'
) => agentEvent('tool_call', { toolCallId, title: name, name, kind: 'read', status })

function transcript(events: Parameters<typeof buildTranscript>[0], permissions: any[] = []) {
  return buildTranscript(events, permissions)
}

describe('condenseTranscript', () => {
  it('leaves an empty transcript alone', () => {
    expect(condenseTranscript([])).toEqual([])
  })

  it('collapses a run of tool calls into one group', () => {
    const items = condenseTranscript(transcript([
      textChunk('working on it'),
      tool('c1', 'Read'),
      tool('c2', 'Bash'),
      tool('c3', 'Edit')
    ]))

    expect(kinds(items)).toEqual(['assistant', 'activity'])
    expect(group(items)).toMatchObject({ toolCalls: 3, thoughts: 0, failed: 0 })
    expect(group(items).items).toHaveLength(3)
  })

  it('leaves a run of one alone — a single card is not clutter', () => {
    const items = condenseTranscript(transcript([textChunk('one moment'), tool('c1'), textChunk('done')]))

    expect(kinds(items)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('honours a different minimum run length', () => {
    const events = [tool('c1'), tool('c2'), textChunk('done')]

    expect(kinds(condenseTranscript(transcript(events), { minRun: 3 })))
      .toEqual(['tool', 'tool', 'assistant'])
    expect(kinds(condenseTranscript(transcript(events), { minRun: 2 })))
      .toEqual(['activity', 'assistant'])
  })

  it('counts thoughts separately and absorbs them into the run', () => {
    const items = condenseTranscript(transcript([
      tool('c1'),
      thoughtChunk('that file is stale'),
      tool('c2'),
      thoughtChunk('try the other one'),
      textChunk('found it')
    ]))

    expect(kinds(items)).toEqual(['activity', 'assistant'])
    expect(group(items)).toMatchObject({ toolCalls: 2, thoughts: 2 })
  })

  it('counts the calls that failed', () => {
    const items = condenseTranscript(transcript([
      tool('c1', 'Bash', 'failed'),
      tool('c2', 'Bash', 'completed'),
      tool('c3', 'Bash', 'failed'),
      textChunk('retrying')
    ]))

    expect(group(items)).toMatchObject({ toolCalls: 3, failed: 2 })
  })

  it('sees a failure that arrived as an update, not as the original call', () => {
    const items = condenseTranscript(transcript([
      tool('c1', 'Bash', 'in_progress'),
      tool('c2', 'Bash', 'in_progress'),
      agentEvent('tool_call_update', { toolCallId: 'c1', status: 'failed' }),
      agentEvent('tool_call_update', { toolCallId: 'c2', status: 'completed' }),
      textChunk('that did not work')
    ]))

    expect(group(items)).toMatchObject({ toolCalls: 2, failed: 1 })
  })

  it('breaks the run down by tool name, most frequent first', () => {
    const items = condenseTranscript(transcript([
      tool('c1', 'Bash'),
      tool('c2', 'Read'),
      tool('c3', 'Read'),
      tool('c4', 'Edit'),
      tool('c5', 'Read'),
      tool('c6', 'Bash'),
      textChunk('done')
    ]))

    expect(group(items).names).toEqual([
      { name: 'Read', count: 3 },
      { name: 'Bash', count: 2 },
      { name: 'Edit', count: 1 }
    ])
    expect(activityBreakdown(group(items))).toBe('Read ×3, Bash ×2, Edit ×1')
  })

  it('falls back to the title when the adapter sent no tool name', () => {
    const items = condenseTranscript(transcript([
      agentEvent('tool_call', { toolCallId: 'c1', title: 'Search the web', kind: 'fetch', status: 'completed' }),
      agentEvent('tool_call', { toolCallId: 'c2', title: 'Search the web', kind: 'fetch', status: 'completed' }),
      textChunk('done')
    ]))

    expect(group(items).names).toEqual([{ name: 'Search the web', count: 2 }])
  })

  describe('what ends a run', () => {
    it.each([
      ['a user message', userMessage('actually, stop')],
      ['an assistant message', agentEvent('agent_message', { text: 'here is what I found', streaming: false })],
      ['a plan', agentEvent('plan', { entries: [{ content: 'Patch it', status: 'pending', priority: 'high' }] })],
      ['a notice', agentEvent('error', { message: 'adapter crashed' })]
    ])('%s splits it into two groups', (_label, breaker) => {
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2'),
        breaker,
        tool('c3'), tool('c4'),
        textChunk('done')
      ]))

      expect(kinds(items)).toHaveLength(4)
      expect(kinds(items)[0]).toBe('activity')
      expect(kinds(items)[2]).toBe('activity')
      expect(group(items, 0).toolCalls).toBe(2)
      expect(group(items, 1).toolCalls).toBe(2)
    })

    it('never swallows a pending permission', () => {
      const pending = permission()
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2'),
        agentEvent('permission_request', { permissionId: pending.id, toolCall: { title: 'Run pnpm install' } }),
        tool('c3'), tool('c4'),
        textChunk('done')
      ], [pending]))

      expect(kinds(items)).toEqual(['activity', 'permission', 'activity', 'assistant'])
    })
  })

  describe('the live tail', () => {
    it('keeps a running tool call out of the group', () => {
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2'), tool('c3'),
        tool('c4', 'Bash', 'in_progress')
      ]))

      expect(kinds(items)).toEqual(['activity', 'tool'])
      expect(group(items).toolCalls).toBe(3)
    })

    it('does the same for a call that has not started yet', () => {
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2'), tool('c3'),
        tool('c4', 'Bash', 'pending')
      ]))

      expect(kinds(items)).toEqual(['activity', 'tool'])
    })

    it('groups a finished tail — there is nothing live to watch', () => {
      const items = condenseTranscript(transcript([tool('c1'), tool('c2'), tool('c3')]))

      expect(kinds(items)).toEqual(['activity'])
      expect(group(items).toolCalls).toBe(3)
    })

    it('keeps a trailing thought out only while the session is working', () => {
      const events = [tool('c1'), tool('c2'), thoughtChunk('what now')]

      expect(kinds(condenseTranscript(transcript(events), { live: true }))).toEqual(['activity', 'thought'])
      expect(kinds(condenseTranscript(transcript(events), { live: false }))).toEqual(['activity'])
    })

    it('leaves the rest of the run alone when the tail is all that is left of it', () => {
      // One grouped item would be a group of one, so nothing is grouped at all.
      const items = condenseTranscript(transcript([textChunk('hi'), tool('c1'), tool('c2', 'Bash', 'in_progress')]))

      expect(kinds(items)).toEqual(['assistant', 'tool', 'tool'])
    })

    it('does not treat a live tail in the middle of the log as one', () => {
      // Only the *last* item can be the live tail; an unfinished call the agent
      // moved on from is history like any other.
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2', 'Bash', 'in_progress'), tool('c3'),
        textChunk('done')
      ]))

      expect(kinds(items)).toEqual(['activity', 'assistant'])
      expect(group(items).toolCalls).toBe(3)
    })
  })

  describe('group identity', () => {
    it('derives the id, seq and timestamp from the first item in the run', () => {
      const items = buildTranscript([tool('c1'), tool('c2'), tool('c3')])
      const condensed = condenseTranscript(items)

      expect(group(condensed)).toMatchObject({
        id: `activity:${items[0]!.id}`,
        seq: items[0]!.seq,
        at: items[0]!.at
      })
    })

    it('keeps the id stable as events are appended below it', () => {
      const events = [tool('c1'), tool('c2'), tool('c3'), textChunk('done')]
      const before = group(condenseTranscript(transcript(events)))

      events.push(userMessage('now the tests'), tool('c4'), tool('c5'))
      const after = group(condenseTranscript(transcript(events)))

      expect(after.id).toBe(before.id)
    })

    it('gives two groups in one transcript different ids', () => {
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2'),
        textChunk('halfway'),
        tool('c3'), tool('c4')
      ]))

      expect(group(items, 0).id).not.toBe(group(items, 1).id)
    })
  })

  it('preserves every item, in order', () => {
    const items = transcript([
      userMessage('fix the build'),
      thoughtChunk('let me look'),
      tool('c1'), tool('c2'),
      textChunk('found it'),
      tool('c3'), tool('c4'), tool('c5')
    ])

    const flattened = condenseTranscript(items)
      .flatMap(item => (item.kind === 'activity' ? item.items : [item]))

    expect(flattened).toEqual(items)
  })
})

describe('activityLabel', () => {
  const group = (toolCalls: number, thoughts: number): ActivityGroup => ({
    id: 'activity:ev_1',
    seq: 1,
    at: '2026-01-01T00:00:00.000Z',
    kind: 'activity',
    items: [],
    toolCalls,
    thoughts,
    failed: 0,
    names: []
  })

  it.each([
    [12, 3, '12 tool calls · 3 thoughts'],
    [1, 1, '1 tool call · 1 thought'],
    [4, 0, '4 tool calls'],
    [0, 2, '2 thoughts']
  ])('says %i tool calls and %i thoughts as "%s"', (toolCalls, thoughts, expected) => {
    expect(activityLabel(group(toolCalls, thoughts))).toBe(expected)
  })
})
