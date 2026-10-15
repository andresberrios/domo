import { describe, expect, it } from 'vitest'

import {
  activityBreakdown,
  activityLabel,
  buildTranscript,
  condenseTranscript,
  currentActivity,
  reconcileCondensed,
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

  it('groups a run of one as well, so that a run never changes what it is drawn as', () => {
    const items = condenseTranscript(transcript([textChunk('one moment'), tool('c1'), textChunk('done')]))

    expect(kinds(items)).toEqual(['assistant', 'activity', 'assistant'])
    expect(group(items).toolCalls).toBe(1)
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
    it('puts a running tool call inside the group, as its last item', () => {
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2'), tool('c3'),
        tool('c4', 'Bash', 'in_progress')
      ]))

      expect(kinds(items)).toEqual(['activity'])
      expect(group(items)).toMatchObject({ toolCalls: 4, live: true })
      expect(group(items).items.at(-1)).toMatchObject({ kind: 'tool', tool: { toolCallId: 'c4' } })
    })

    it('does the same for a call that has not started yet', () => {
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2'), tool('c3'),
        tool('c4', 'Bash', 'pending')
      ]))

      expect(kinds(items)).toEqual(['activity'])
      expect(group(items).live).toBe(true)
    })

    it('draws the same row from the first call starting to the last one finishing', () => {
      // Every step of a turn, as the log grows. A call drawn outside the group
      // while it ran and folded in when it finished re-parented on every call,
      // which is what moved the view up and down.
      const steps: Parameters<typeof buildTranscript>[0][] = []
      const events: Parameters<typeof buildTranscript>[0] = [userMessage('run the checks')]
      for (const id of ['c1', 'c2', 'c3']) {
        events.push(tool(id, 'Bash', 'in_progress'))
        steps.push([...events])
        events.push(agentEvent('tool_call_update', { toolCallId: id, status: 'completed' }))
        steps.push([...events])
      }

      const rows = steps.map(step => condenseTranscript(transcript(step), { live: true }))

      for (const row of rows) expect(kinds(row)).toEqual(['user', 'activity'])
      expect(new Set(rows.map(row => group(row).id)).size).toBe(1)
      expect(rows.map(row => group(row).toolCalls)).toEqual([1, 1, 2, 2, 3, 3])
    })

    it('closes the group once the session stops working', () => {
      const events = [tool('c1'), tool('c2')]

      expect(group(condenseTranscript(transcript(events), { live: true })).live).toBe(true)
      expect(group(condenseTranscript(transcript(events), { live: false })).live).toBe(false)
    })

    it('closes the group when something other than activity follows it', () => {
      const items = condenseTranscript(transcript([tool('c1'), tool('c2'), textChunk('done')]), { live: true })

      expect(group(items).live).toBe(false)
    })

    it('draws a run of one call as the same row while it runs and once it is over', () => {
      // A group while live and a plain card once closed swapped one element for
      // another of a different height when the answer arrived.
      const events = [textChunk('hi'), tool('c1', 'Bash', 'in_progress')]
      const live = condenseTranscript(transcript(events), { live: true })
      events.push(agentEvent('tool_call_update', { toolCallId: 'c1', status: 'completed' }), textChunk('done'))
      const closed = condenseTranscript(transcript(events), { live: true })

      expect(kinds(live)).toEqual(['assistant', 'activity'])
      expect(kinds(closed)).toEqual(['assistant', 'activity', 'assistant'])
      expect(group(closed).id).toBe(group(live).id)
    })

    it('takes a trailing thought into the open group', () => {
      const items = condenseTranscript(transcript([tool('c1'), tool('c2'), thoughtChunk('what now')]), { live: true })

      expect(kinds(items)).toEqual(['activity'])
      expect(group(items)).toMatchObject({ toolCalls: 2, thoughts: 1, live: true })
    })

    it('opens a group for a lone streaming thought, which the next call joins', () => {
      const events = [userMessage('hi'), thoughtChunk('let me see')]
      const thinking = condenseTranscript(transcript(events), { live: true })
      events.push(tool('c1', 'Bash', 'in_progress'))
      const calling = condenseTranscript(transcript(events), { live: true })

      expect(kinds(thinking)).toEqual(['user', 'activity'])
      expect(group(thinking)).toMatchObject({ thoughts: 1, live: true })
      expect(group(calling).id).toBe(group(thinking).id)
    })

    it('does not treat a live tail in the middle of the log as one', () => {
      // Only the *last* item can be the live tail; an unfinished call the agent
      // moved on from is history like any other.
      const items = condenseTranscript(transcript([
        tool('c1'), tool('c2', 'Bash', 'in_progress'), tool('c3'),
        textChunk('done')
      ]))

      expect(kinds(items)).toEqual(['activity', 'assistant'])
      expect(group(items)).toMatchObject({ toolCalls: 3, live: false })
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

describe('reconcileCondensed', () => {
  it('keeps a group that stands for the same items', () => {
    const items = transcript([tool('c1'), tool('c2')])
    const before = condenseTranscript(items)

    expect(reconcileCondensed(before, condenseTranscript(items))[0]).toBe(before[0])
  })

  it('replaces a group that closed, though its items did not change', () => {
    // The header shows the live call only while the group is open, so a group
    // carried forward past the end of the turn would keep its spinner.
    const items = transcript([tool('c1'), tool('c2')])
    const before = condenseTranscript(items, { live: true })
    const after = reconcileCondensed(before, condenseTranscript(items, { live: false }))

    expect(after[0]).not.toBe(before[0])
    expect(group(after).live).toBe(false)
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
    names: [],
    live: false
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

describe('currentActivity', () => {
  const live = (events: Parameters<typeof buildTranscript>[0]) => currentActivity(condenseTranscript(transcript(events), { live: true }))

  it('is thinking when the turn has only just started', () => {
    expect(live([userMessage('hi')])).toBe('thinking')
    expect(currentActivity([])).toBe('thinking')
  })

  it('is a tool while a live run of calls ends on a call', () => {
    expect(live([userMessage('hi'), tool('t1', 'Bash', 'in_progress')])).toBe('tool')
  })

  it('is thinking while a live run ends on a thought', () => {
    expect(live([userMessage('hi'), tool('t1'), thoughtChunk('let me see')])).toBe('thinking')
  })

  it('is writing while a reply streams', () => {
    expect(live([userMessage('hi'), tool('t1'), textChunk('Here is')])).toBe('writing')
  })
})
