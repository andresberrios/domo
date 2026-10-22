import { describe, expect, it } from 'vitest'

import { applyBoardOps, BoardEditError, diffBoard, parseBoardOps, type BoardEditOptions } from '../../server/lib/board/ops'
import { applySubmission } from '../../server/lib/board/submit'
import { boardForAgent, tidyHint } from '../../server/lib/board/read'
import { attention, draftChangeCount, effectiveDraft, effectiveGroupDraft, groupContents, groupDraftKey, isCleared, isFolded, needsYou, sortBoardElements } from '../../shared/board'
import { boardElementContent, type Board, type BoardDraft } from '../../shared/types/board'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:01:00.000Z'
const T2 = '2026-01-01T00:02:00.000Z'

function empty(): Board {
  return { ownerId: 'ag_x', headline: null, groups: [], folds: {}, groupResponses: {}, elements: [], agentChangedAt: null, seenAt: null }
}

function edit(board: Board, ops: unknown[], now = T1, replaceAll = false, extra: Partial<BoardEditOptions> = {}): Board {
  return applyBoardOps(board, parseBoardOps(ops), { now, replaceAll, ...extra })
}

function seeded(): Board {
  return edit(empty(), [
    { op: 'headline', text: 'Migrating the API' },
    { op: 'put', id: 'db', kind: 'question', title: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sqlite', label: 'SQLite' }] },
    { op: 'put', id: 'plan', kind: 'checklist', title: 'Plan', group: 'Work', items: [
      { id: 'schema', text: 'Write the schema', status: 'done' },
      { id: 'tests', text: 'Write tests', status: 'ongoing' }
    ] },
    { op: 'put', id: 'zod', kind: 'decision', title: 'Validate with zod', body: 'Already a dependency.', group: 'Work' }
  ], T0)
}

const titles = (board: Board) => board.groups.map(group => group.title)
const ids = (board: Board) => sortBoardElements(board.elements, board.groups).map(element => element.id)
const element = (board: Board, id: string) => board.elements.find(item => item.id === id)!

describe('board schema', () => {
  it('fills defaults and refuses fields of another kind', () => {
    expect(boardElementContent.parse({ kind: 'question', title: 'Q' })).toEqual({ kind: 'question', title: 'Q', options: [], multiple: false, allowCustom: true })
    expect(boardElementContent.safeParse({ kind: 'note', title: 'N', items: [] }).success).toBe(false)
    expect(boardElementContent.safeParse({ kind: 'checklist', title: 'C', items: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] }).success).toBe(false)
    expect(boardElementContent.safeParse({ kind: 'checklist', title: 'C', items: [{ id: 'a', text: 'x', status: 'finished' }] }).success).toBe(false)
  })

  it('names the op that is wrong', () => {
    expect(() => parseBoardOps([{ op: 'put', id: 'ok', kind: 'note', title: 'x' }, { op: 'paint', id: 'x' }])).toThrow(/ops\[1\] \(paint\)/)
    expect(() => parseBoardOps([{ op: 'put', id: 'has space' }])).toThrow(/ops\[0\] \(put\): id/)
  })
})

describe('applyBoardOps', () => {
  it('builds a board in order, groups created on first use', () => {
    const board = seeded()
    expect(board.headline).toBe('Migrating the API')
    expect(board.groups).toEqual([{ title: 'Work', updatedAt: T0 }])
    expect(ids(board)).toEqual(['db', 'plan', 'zod'])
    expect(element(board, 'plan').content).toMatchObject({ kind: 'checklist', items: [{ status: 'done' }, { status: 'ongoing' }] })
  })

  it('changes only the fields a put names, and refuses a new element without kind and title', () => {
    const board = edit(seeded(), [{ op: 'put', id: 'zod', title: 'Validate with zod 4' }])
    expect(element(board, 'zod').content).toMatchObject({ title: 'Validate with zod 4', body: 'Already a dependency.' })
    expect(element(board, 'zod').updatedAt).toBe(T1)
    expect(element(board, 'db').updatedAt).toBe(T0)
    expect(() => edit(seeded(), [{ op: 'put', id: 'new', title: 'x' }])).toThrow(/needs kind and title/)
  })

  it('a put naming the group the element is in does not move it', () => {
    const board = edit(seeded(), [{ op: 'put', id: 'plan', group: 'Work', body: 'b' }])
    expect(ids(board)).toEqual(['db', 'plan', 'zod'])
  })

  it('changes a kind cleanly: what only the old kind had goes', () => {
    const board = edit(seeded(), [{ op: 'put', id: 'plan', kind: 'note', tone: 'warning' }])
    expect(element(board, 'plan').content).toEqual({ kind: 'note', title: 'Plan', tone: 'warning' })
  })

  it('updates items by id, appends new ones and removes', () => {
    const board = edit(seeded(), [
      { op: 'items', id: 'plan', set: [{ id: 'tests', status: 'done' }, { id: 'docs', text: 'Docs' }], remove: ['schema'] }
    ])
    expect(element(board, 'plan').content).toMatchObject({ items: [
      { id: 'tests', text: 'Write tests', status: 'done' },
      { id: 'docs', text: 'Docs', status: 'todo' }
    ] })
    expect(() => edit(seeded(), [{ op: 'items', id: 'zod', set: [{ id: 'a' }] }])).toThrow(/only checklist, links and metrics/)
    expect(() => edit(seeded(), [{ op: 'items', id: 'plan', set: [{ id: 'new' }] }])).toThrow(/text/)
  })

  it('moves by anchor, across groups, and to the end', () => {
    let board = edit(seeded(), [{ op: 'move', id: 'zod', before: 'plan' }])
    expect(ids(board)).toEqual(['db', 'zod', 'plan'])
    board = edit(board, [{ op: 'move', id: 'db', group: 'Work', after: 'zod' }])
    expect(ids(board)).toEqual(['zod', 'db', 'plan'])
    board = edit(board, [{ op: 'move', id: 'zod', group: 'Work' }])
    expect(ids(board)).toEqual(['db', 'plan', 'zod'])
    expect(board.elements.every(item => item.group === 'Work')).toBe(true)
    expect(() => edit(board, [{ op: 'move', id: 'zod' }])).toThrow(/say where/)
    expect(() => edit(board, [{ op: 'move', id: 'zod', group: null, before: 'plan' }])).toThrow(/is not in group/)
  })

  it('describes, renames, orders and removes groups; empty bare ones go', () => {
    let board = seeded()
    board.folds = { Work: false }
    board = edit(board, [
      { op: 'put', id: 'risk', kind: 'note', title: 'Flaky CI', group: 'Risks' },
      { op: 'group', title: 'Risks', before: 'Work' },
      { op: 'group', title: 'Work', renameTo: 'Doing', summary: 'Halfway', status: 'active', links: [{ kind: 'agent', target: 'ag_w' }] },
      { op: 'group', title: 'Never used' },
      { op: 'group', title: 'Waiting on review', status: 'waiting' }
    ])
    expect(titles(board)).toEqual(['Risks', 'Doing', 'Waiting on review'])
    expect(board.groups[1]).toEqual({ title: 'Doing', summary: 'Halfway', status: 'active', links: [{ kind: 'agent', target: 'ag_w' }], updatedAt: T1 })
    expect(board.folds).toEqual({ Doing: false })
    expect(element(board, 'plan').group).toBe('Doing')
    expect(ids(board)).toEqual(['db', 'risk', 'plan', 'zod'])
    board = edit(board, [{ op: 'group', title: 'Doing', summary: null, links: null }])
    expect(board.groups[1]).toEqual({ title: 'Doing', status: 'active', updatedAt: T1 })
    board = edit(board, [{ op: 'remove_group', title: 'Doing' }])
    expect(ids(board)).toEqual(['db', 'risk'])
    expect(() => edit(board, [{ op: 'group', title: 'Risks', renameTo: 'Waiting on review' }])).toThrow(/already exists/)
  })

  it('applies a batch whole or not at all', () => {
    const before = seeded()
    expect(() => edit(before, [{ op: 'remove', id: 'db' }, { op: 'remove', id: 'nope' }])).toThrow(BoardEditError)
    expect(() => edit(before, [{ op: 'remove', id: 'db' }, { op: 'remove', id: 'nope' }])).toThrow(/ops\[1\] \(remove nope\): no element "nope"/)
    expect(ids(before)).toEqual(['db', 'plan', 'zod'])
  })

  it('brings an acknowledged or dismissed element back when the agent changes it', () => {
    const board = seeded()
    element(board, 'zod').response = { acknowledgedAt: T0 }
    element(board, 'db').response = { dismissedAt: T0, answer: { options: ['pg'], at: T0 } }
    expect(element(edit(board, [{ op: 'put', id: 'zod', title: 'Validate with zod' }]), 'zod').response.acknowledgedAt).toBe(T0)
    const changed = edit(board, [{ op: 'put', id: 'zod', body: 'Changed' }, { op: 'put', id: 'db', title: 'Which DB?' }])
    expect(element(changed, 'zod').response).toEqual({})
    expect(element(changed, 'db').response).toEqual({ answer: { options: ['pg'], at: T0 } })
    expect(element(edit(board, [{ op: 'put', id: 'db', reopen: true }]), 'db').response).toEqual({ dismissedAt: T0 })
  })

  it('keeps a done item acknowledged only while it is done', () => {
    const board = seeded()
    element(board, 'plan').response = { acknowledgedItems: ['schema'] }
    expect(element(edit(board, [{ op: 'items', id: 'plan', set: [{ id: 'tests', status: 'done' }] }]), 'plan').response.acknowledgedItems).toEqual(['schema'])
    expect(element(edit(board, [{ op: 'items', id: 'plan', set: [{ id: 'schema', status: 'ongoing' }] }]), 'plan').response.acknowledgedItems).toBeUndefined()
  })

  it('replaceAll starts over but keeps what the human said on an id put again', () => {
    const board = seeded()
    element(board, 'db').response = { answer: { options: ['pg'], at: T0 } }
    element(board, 'db').thread = [{ from: 'user', text: 'pg 16', at: T0 }]
    const replaced = edit(board, [
      { op: 'put', id: 'db', kind: 'question', title: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }] }
    ], T1, true)
    expect(ids(replaced)).toEqual(['db'])
    expect(replaced.headline).toBeNull()
    expect(replaced.groups).toEqual([])
    expect(element(replaced, 'db').response.answer?.options).toEqual(['pg'])
    expect(element(replaced, 'db').thread).toHaveLength(1)
    expect(element(replaced, 'db').createdAt).toBe(T0)
  })

  it('appends agent replies to the thread', () => {
    const board = edit(seeded(), [{ op: 'reply', id: 'zod', text: 'Yes, v4.' }])
    expect(element(board, 'zod').thread).toEqual([{ from: 'agent', text: 'Yes, v4.', at: T1 }])
  })

  it('diffs to the rows that changed', () => {
    const before = seeded()
    const after = edit(before, [{ op: 'items', id: 'plan', set: [{ id: 'tests', status: 'done' }] }, { op: 'remove', id: 'db' }])
    const diff = diffBoard(before, after)
    expect(diff.upserts.map(item => item.id)).toEqual(['plan'])
    expect(diff.deletes).toEqual(['db'])
    // The group says when it last changed.
    expect(diff.boardChanged).toBe(true)
    expect(diffBoard(before, edit(before, [{ op: 'remove', id: 'db' }])).boardChanged).toBe(false)
    expect(diffBoard(before, edit(before, [{ op: 'headline', text: 'Done' }])).boardChanged).toBe(true)
  })
})

describe('what needs the human', () => {
  it('counts open questions and what is left to acknowledge, and folds done groups', () => {
    const board = seeded()
    expect(attention(board.elements)).toEqual({ questions: 1, unacknowledged: 2 })
    expect(board.elements.filter(needsYou).map(item => item.id)).toEqual(['db', 'plan', 'zod'])
    element(board, 'db').response = { answer: { options: ['pg'], at: T1 } }
    element(board, 'plan').response = { acknowledgedItems: ['schema'] }
    element(board, 'zod').response = { acknowledgedAt: T1 }
    expect(attention(board.elements)).toEqual({ questions: 0, unacknowledged: 0 })
    expect(board.elements.filter(needsYou)).toEqual([])
    expect(isFolded({ title: 'A', status: 'done' }, {})).toBe(true)
    expect(isFolded({ title: 'A', status: 'done' }, { A: false })).toBe(false)
    expect(isFolded({ title: 'A' }, { A: true })).toBe(true)
  })
})

describe('drafts and submission', () => {
  it('drops what no longer applies', () => {
    const board = seeded()
    expect(effectiveDraft(element(board, 'db'), { answer: { options: ['mysql', 'pg', 'sqlite'] } })).toEqual({ answer: { options: ['pg'] } })
    expect(effectiveDraft(element(board, 'plan'), { acknowledgeItems: ['schema', 'tests'], acknowledge: true })).toEqual({ acknowledgeItems: ['schema'] })
    expect(effectiveDraft(element(board, 'zod'), { reply: '  ', acknowledge: true })).toEqual({ acknowledge: true })
    expect(draftChangeCount({ answer: { options: ['pg'] }, reply: 'x', acknowledgeItems: ['a', 'b'] })).toBe(4)
  })

  it('applies drafts and writes one message with ids', () => {
    const board = seeded()
    const drafts = new Map<string, BoardDraft>([
      ['db', { answer: { options: ['pg'], text: 'Version 16' } }],
      ['plan', { acknowledgeItems: ['schema'], reply: 'Skip the down migration.\nIt is never run.' }],
      ['zod', { acknowledge: true }],
      ['gone', { dismiss: true }]
    ])
    const submission = applySubmission(board, drafts, T2)!
    expect(submission.changed).toEqual(['db', 'plan', 'zod'])
    expect(element(submission.board, 'db').response.answer).toEqual({ options: ['pg'], text: 'Version 16', at: T2 })
    expect(element(submission.board, 'plan').response.acknowledgedItems).toEqual(['schema'])
    expect(element(submission.board, 'plan').thread).toEqual([{ from: 'user', text: 'Skip the down migration.\nIt is never run.', at: T2 }])
    expect(isCleared(element(submission.board, 'zod'))).toBe(true)
    expect(submission.message).toBe([
      '[Status board] The human responded on your status board (element ids in brackets):',
      '',
      '- Question "Which database?" [db]: answered "Postgres" [pg]; and added:\n    Version 16',
      '',
      'Work:',
      '- Checklist "Plan" [plan]: acknowledged done "Write the schema" [schema]; replied:\n    Skip the down migration.\n    It is never run.',
      '- Decision "Validate with zod" [zod]: acknowledged',
      '',
      'Act on this, and bring the board up to date with update_board: remove what is settled, and a group they cleared or dismissed once nothing in it still matters.'
    ].join('\n'))
    expect(applySubmission(board, new Map([['gone', { dismiss: true }]]), T2)).toBeNull()
  })

  it('reads back compactly for the agent', () => {
    const board = applySubmission(seeded(), new Map([['db', { answer: { options: ['pg'] } }]]), T2)!.board
    const read = boardForAgent(board)
    expect(read.headline).toBe('Migrating the API')
    expect(read.elements[0]).toEqual({
      id: 'db',
      kind: 'question',
      title: 'Which database?',
      options: [{ id: 'pg', label: 'Postgres' }, { id: 'sqlite', label: 'SQLite' }],
      multiple: false,
      allowCustom: true,
      answer: { options: ['pg'] }
    })
  })
})

describe('clearing groups', () => {
  /** Two finished workstreams, one empty and one with a done checklist, beside the seeded "Work". */
  function finished(): Board {
    return edit(seeded(), [
      { op: 'group', title: 'Shipped', summary: 'Merged to main.', status: 'done' },
      { op: 'put', id: 'queue', kind: 'checklist', title: 'Queue', group: 'Next', items: [{ id: 'a', text: 'A', status: 'done' }] },
      { op: 'group', title: 'Next', status: 'done' }
    ], T1)
  }

  it('clears a done group and dismisses any group through submit, in one message under each group', () => {
    const board = finished()
    const submission = applySubmission(board, new Map<string, BoardDraft>([
      [groupDraftKey('Shipped'), { acknowledge: true }],
      [groupDraftKey('Work'), { dismiss: true }],
      // Not done: a clear means nothing on it.
      [groupDraftKey('Next'), {}],
      [groupDraftKey('Gone'), { dismiss: true }]
    ]), T2)!
    expect(submission.changed).toEqual([groupDraftKey('Work'), groupDraftKey('Shipped')])
    expect(submission.board.groupResponses).toEqual({ Shipped: { acknowledgedAt: T2 }, Work: { dismissedAt: T2 } })
    expect(submission.message).toContain('Work:\n- Group "Work": dismissed')
    expect(submission.message).toContain('Shipped:\n- Group "Shipped": cleared as done (they have read its outcome)')
    // The group's line comes before its elements'.
    const withElement = applySubmission(board, new Map<string, BoardDraft>([
      ['zod', { acknowledge: true }],
      [groupDraftKey('Work'), { dismiss: true }]
    ]), T2)!
    expect(withElement.message).toContain('Work:\n- Group "Work": dismissed\n- Decision "Validate with zod" [zod]: acknowledged')
  })

  it('takes a clear only on a done group, and nothing on one already cleared', () => {
    expect(effectiveGroupDraft({ title: 'A', status: 'active' }, undefined, { acknowledge: true })).toEqual({})
    expect(effectiveGroupDraft({ title: 'A', status: 'done' }, undefined, { acknowledge: true })).toEqual({ acknowledge: true })
    expect(effectiveGroupDraft({ title: 'A', status: 'active' }, undefined, { dismiss: true, acknowledge: true })).toEqual({ dismiss: true })
    expect(effectiveGroupDraft({ title: 'A', status: 'done' }, { acknowledgedAt: T0 }, { dismiss: true })).toEqual({})
    const board = finished()
    board.groupResponses = { Shipped: { acknowledgedAt: T1 } }
    expect(applySubmission(board, new Map([[groupDraftKey('Shipped'), { acknowledge: true }]]), T2)).toBeNull()
  })

  it('brings a cleared group back when the agent says something new in it, not when it tidies', () => {
    const board = finished()
    board.groupResponses = { Shipped: { acknowledgedAt: T1 }, Next: { acknowledgedAt: T1 }, Work: { dismissedAt: T1 } }
    // Repeating what it said, or taking something out, leaves them cleared.
    let after = edit(board, [
      { op: 'group', title: 'Shipped', summary: 'Merged to main.', status: 'done' },
      { op: 'put', id: 'queue', title: 'Queue', group: 'Next' },
      { op: 'remove', id: 'zod' }
    ], T2)
    expect(Object.keys(after.groupResponses).sort()).toEqual(['Next', 'Shipped', 'Work'])
    expect(after.groups.find(group => group.title === 'Shipped')!.updatedAt).toBe(T1)
    // A removal is still news of a kind: the group says when it last changed.
    expect(after.groups.find(group => group.title === 'Work')!.updatedAt).toBe(T2)
    after = edit(board, [
      { op: 'group', title: 'Shipped', summary: 'Merged, and reverted.' },
      { op: 'items', id: 'queue', set: [{ id: 'b', text: 'B' }] },
      { op: 'put', id: 'risk', kind: 'note', title: 'New risk', group: 'Work' }
    ], T2)
    expect(after.groupResponses).toEqual({})
    expect(after.groups.every(group => group.updatedAt === T2)).toBe(true)
  })

  it('keeps the response with a renamed group, drops it with a removed one, and keeps it across an unchanged replaceAll', () => {
    const board = finished()
    board.groupResponses = { Shipped: { acknowledgedAt: T1 }, Next: { acknowledgedAt: T1 } }
    const renamed = edit(board, [{ op: 'group', title: 'Shipped', renameTo: 'Released' }, { op: 'remove_group', title: 'Next' }], T2)
    expect(renamed.groupResponses).toEqual({ Released: { acknowledgedAt: T1 } })
    expect(diffBoard(board, renamed).boardChanged).toBe(true)
    const replaced = edit(board, [{ op: 'group', title: 'Shipped', summary: 'Merged to main.', status: 'done' }], T2, true)
    expect(replaced.groupResponses).toEqual({ Shipped: { acknowledgedAt: T1 } })
  })

  it('says what a group holds, and reads back cleared groups to the agent', () => {
    const board = finished()
    expect(groupContents([])).toBe('no items')
    expect(groupContents(board.elements.filter(item => item.group === 'Work'))).toBe('2 open items')
    element(board, 'queue').response = { acknowledgedItems: ['a'] }
    expect(groupContents(board.elements.filter(item => item.group === 'Next'))).toBe('nothing open')
    board.groupResponses = { Shipped: { acknowledgedAt: T1 }, Work: { dismissedAt: T1 } }
    const read = boardForAgent(board)
    expect(read.groups).toEqual([
      { title: 'Work', dismissed: true },
      { title: 'Shipped', summary: 'Merged to main.', status: 'done', cleared: true },
      { title: 'Next', status: 'done' }
    ])
  })

  it('nudges the agent only once the board is piling up', () => {
    const board = finished()
    expect(tidyHint(board)).toBeNull()
    board.groupResponses = { Shipped: { acknowledgedAt: T1 } }
    element(board, 'queue').response = { acknowledgedItems: ['a'] }
    expect(tidyHint(board)).toBeNull()
    element(board, 'zod').response = { acknowledgedAt: T1 }
    expect(tidyHint(board)).toBe('The human has cleared group "Shipped", zod, queue: remove what no longer matters (remove, remove_group).')
    const done = edit(empty(), ['A', 'B', 'C', 'D'].map(title => ({ op: 'group', title, status: 'done' })))
    expect(tidyHint(done)).toMatch(/^4 groups are done/)
  })
})
