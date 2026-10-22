import type { z } from 'zod'

import {
  BOARD_LIMITS,
  boardElementContent,
  boardOp,
  type Board,
  type BoardElement,
  type BoardGroup,
  type BoardElementContent,
  type BoardOp
} from '../../../shared/types/board'

/**
 * The agent's edits to a board, as a pure function of the board before them.
 * A batch applies whole or not at all: the first op that does not make sense
 * rejects it, with a message that names the op, so the agent can fix and
 * resend without reading the board again.
 */

export class BoardEditError extends Error {}

function describeZod(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ')
}

/** The ops, checked. Accepts one op or a list. */
export function parseBoardOps(input: unknown): BoardOp[] {
  const list = Array.isArray(input) ? input : input === undefined ? [] : [input]
  return list.map((raw, index) => {
    const parsed = boardOp.safeParse(raw)
    if (!parsed.success) {
      const name = typeof (raw as any)?.op === 'string' ? ` (${(raw as any).op})` : ''
      throw new BoardEditError(`ops[${index}]${name}: ${describeZod(parsed.error)}`)
    }
    return parsed.data
  })
}

const KIND_FIELDS = ['options', 'multiple', 'allowCustom', 'items', 'alternatives', 'tone'] as const

function parseContent(candidate: Record<string, unknown>): BoardElementContent {
  const parsed = boardElementContent.safeParse(candidate)
  if (!parsed.success) throw new BoardEditError(describeZod(parsed.error))
  return parsed.data
}

function stripKindFields(content: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(content).filter(([key]) => !(KIND_FIELDS as readonly string[]).includes(key)))
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * What an element's response keeps once the agent has rewritten it. An
 * acknowledgement or a dismissal was of what the element said, so a change
 * brings it back in front of the human; a done item stays acknowledged only
 * while it is still done. An answer stays: the agent clears it with `reopen`.
 */
function carryResponse(element: BoardElement, before: BoardElementContent | null, reopen: boolean): void {
  const response = { ...element.response }
  if (before && !same(before, element.content)) {
    delete response.acknowledgedAt
    delete response.dismissedAt
  }
  if (response.acknowledgedItems) {
    const done = new Set(element.content.kind === 'checklist'
      ? element.content.items.filter(item => item.status === 'done').map(item => item.id)
      : [])
    const kept = response.acknowledgedItems.filter(id => done.has(id))
    if (kept.length) response.acknowledgedItems = kept
    else delete response.acknowledgedItems
  }
  if (reopen) delete response.answer
  element.response = response
}

interface Working {
  board: Board
  /** By id, for the replace-all case: an element put again keeps the human's response and thread. */
  previous: Map<string, BoardElement>
  /** Groups renamed in this batch: new title to the title before it. */
  renamed: Map<string, string>
  now: string
}

function find(work: Working, id: string): BoardElement {
  const element = work.board.elements.find(item => item.id === id)
  if (!element) throw new BoardEditError(`no element "${id}"`)
  return element
}

function groupNamed(work: Working, title: string): BoardGroup | undefined {
  return work.board.groups.find(group => group.title === title)
}

function ensureGroup(work: Working, title: string | null): void {
  if (title === null || groupNamed(work, title)) return
  if (work.board.groups.length >= BOARD_LIMITS.groups) {
    throw new BoardEditError(`at most ${BOARD_LIMITS.groups} groups`)
  }
  work.board.groups.push({ title })
}

/**
 * Put `element` in `group`, at the end or next to an anchor element. The
 * anchor decides the group when none is named. Positions are fractional,
 * so a move writes one row rather than renumbering its neighbours.
 */
function place(
  work: Working,
  element: BoardElement,
  group: string | null | undefined,
  before: string | undefined,
  after: string | undefined
): void {
  const anchorId = before ?? after
  const anchor = anchorId ? find(work, anchorId) : null
  if (anchor && anchor.id === element.id) throw new BoardEditError('an element cannot be placed next to itself')
  if (anchor && group !== undefined && anchor.group !== group) {
    throw new BoardEditError(`"${anchor.id}" is not in group ${JSON.stringify(group)}`)
  }
  const target = anchor ? anchor.group : group === undefined ? element.group : group
  ensureGroup(work, target)
  const siblings = work.board.elements
    .filter(item => item.group === target && item.id !== element.id)
    .sort((a, b) => a.position - b.position)
  let position: number
  if (!anchor) {
    position = (siblings.at(-1)?.position ?? 0) + 1
  } else {
    const index = siblings.findIndex(item => item.id === anchor.id)
    const neighbour = before ? siblings[index - 1] : siblings[index + 1]
    position = neighbour
      ? (anchor.position + neighbour.position) / 2
      : anchor.position + (before ? -1 : 1)
  }
  element.group = target
  element.position = position
}

function put(work: Working, op: Extract<BoardOp, { op: 'put' }>): void {
  const existing = work.board.elements.find(item => item.id === op.id)
  const given: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(op)) {
    if (value === undefined || ['op', 'id', 'group', 'before', 'after', 'reopen'].includes(key)) continue
    given[key] = value
  }
  if (!existing) {
    if (!op.kind || !op.title) throw new BoardEditError(`new element "${op.id}" needs kind and title`)
    if (work.board.elements.length >= BOARD_LIMITS.elements) {
      throw new BoardEditError(`at most ${BOARD_LIMITS.elements} elements; remove some first`)
    }
    const prior = work.previous.get(op.id)
    const element: BoardElement = {
      id: op.id,
      group: null,
      position: 0,
      content: parseContent(given),
      response: prior?.response ?? {},
      thread: prior?.thread ?? [],
      createdAt: prior?.createdAt ?? work.now,
      updatedAt: work.now
    }
    if (prior) carryResponse(element, prior.content.kind === element.content.kind ? prior.content : null, op.reopen === true)
    place(work, element, op.group === undefined && !op.before && !op.after ? null : op.group, op.before, op.after)
    work.board.elements.push(element)
    return
  }
  const before = existing.content
  // Another kind is another element under the same id: what only the old kind had goes.
  const start = op.kind && op.kind !== before.kind ? stripKindFields(before) : { ...before }
  existing.content = parseContent({ ...start, ...given })
  carryResponse(existing, before, op.reopen === true)
  // Naming the group it is already in is not a move: agents repeat it on every put.
  const moved = (op.group !== undefined && op.group !== existing.group) || op.before || op.after
  if (moved) place(work, existing, op.group, op.before, op.after)
}

function items(work: Working, op: Extract<BoardOp, { op: 'items' }>): void {
  const element = find(work, op.id)
  const content = element.content
  if (content.kind !== 'checklist' && content.kind !== 'links' && content.kind !== 'metrics') {
    throw new BoardEditError(`"${op.id}" is a ${content.kind}; only checklist, links and metrics have items`)
  }
  const removed = new Set(op.remove ?? [])
  let list: Array<Record<string, unknown>> = (content.items as Array<Record<string, unknown>>)
    .filter(item => !removed.has(item.id as string))
  for (const change of op.set ?? []) {
    const index = list.findIndex(item => item.id === change.id)
    if (index >= 0) list[index] = { ...list[index], ...change }
    else list = [...list, change]
  }
  element.content = parseContent({ ...content, items: list })
  carryResponse(element, content, false)
}

function group(work: Working, op: Extract<BoardOp, { op: 'group' }>): void {
  const groups = work.board.groups
  ensureGroup(work, op.title)
  const entry = groupNamed(work, op.title)!
  if (op.renameTo && op.renameTo !== op.title) {
    if (groupNamed(work, op.renameTo)) throw new BoardEditError(`group "${op.renameTo}" already exists`)
    for (const element of work.board.elements) {
      if (element.group === op.title) element.group = op.renameTo
    }
    // The human's fold and response go with the group.
    if (op.title in work.board.folds) {
      const { [op.title]: folded, ...rest } = work.board.folds
      work.board.folds = { ...rest, [op.renameTo]: folded! }
    }
    if (op.title in work.board.groupResponses) {
      const { [op.title]: response, ...rest } = work.board.groupResponses
      work.board.groupResponses = { ...rest, [op.renameTo]: response! }
    }
    work.renamed.set(op.renameTo, work.renamed.get(op.title) ?? op.title)
    entry.title = op.renameTo
  }
  if (op.summary !== undefined) {
    if (op.summary) entry.summary = op.summary
    else delete entry.summary
  }
  if (op.status !== undefined) {
    if (op.status) entry.status = op.status
    else delete entry.status
  }
  if (op.links !== undefined) {
    if (op.links?.length) entry.links = op.links
    else delete entry.links
  }
  const anchor = op.before ?? op.after
  if (anchor) {
    if (anchor === entry.title) throw new BoardEditError('a group cannot be placed next to itself')
    const other = groupNamed(work, anchor)
    if (!other) throw new BoardEditError(`no group "${anchor}"`)
    groups.splice(groups.indexOf(entry), 1)
    groups.splice(groups.indexOf(other) + (op.before ? 0 : 1), 0, entry)
  }
}

function apply(work: Working, op: BoardOp): void {
  const board = work.board
  switch (op.op) {
    case 'put':
      return put(work, op)
    case 'items':
      return items(work, op)
    case 'remove':
      find(work, op.id)
      board.elements = board.elements.filter(item => item.id !== op.id)
      return
    case 'move': {
      if (op.group === undefined && !op.before && !op.after) throw new BoardEditError('say where: group, before or after')
      // Without an anchor, to the end of the group.
      place(work, find(work, op.id), op.group, op.before, op.after)
      return
    }
    case 'group':
      return group(work, op)
    case 'remove_group':
      if (!groupNamed(work, op.title)) throw new BoardEditError(`no group "${op.title}"`)
      board.groups = board.groups.filter(entry => entry.title !== op.title)
      board.elements = board.elements.filter(item => item.group !== op.title)
      board.groupResponses = Object.fromEntries(Object.entries(board.groupResponses).filter(([title]) => title !== op.title))
      return
    case 'reply': {
      const element = find(work, op.id)
      element.thread = [...element.thread, { from: 'agent' as const, text: op.text, at: work.now }].slice(-BOARD_LIMITS.thread)
      return
    }
    case 'headline':
      board.headline = op.text || null
  }
}

function clone(board: Board): Board {
  return structuredClone(board)
}

export interface BoardEditOptions {
  now: string
  replaceAll?: boolean
}

/**
 * The board after the agent's ops. `replaceAll` starts from an empty board;
 * an element put again under an id it had keeps what the human said on it.
 * A group left with no elements and nothing said about it goes.
 */
export function applyBoardOps(board: Board, ops: BoardOp[], options: BoardEditOptions): Board {
  const work: Working = { board: clone(board), previous: new Map(), renamed: new Map(), now: options.now }
  if (options.replaceAll) {
    for (const element of work.board.elements) work.previous.set(element.id, element)
    work.board.elements = []
    work.board.groups = []
    work.board.headline = null
  }
  ops.forEach((op, index) => {
    try {
      apply(work, op)
    } catch (error) {
      const label = 'id' in op ? ` ${op.id}` : 'title' in op ? ` "${op.title}"` : ''
      throw new BoardEditError(`ops[${index}] (${op.op}${label}): ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const used = new Set(work.board.elements.map(element => element.group))
  work.board.groups = work.board.groups.filter(entry => used.has(entry.title) || entry.summary || entry.status)
  // What changed is stamped once, after the whole batch.
  const before = new Map(board.elements.map(element => [element.id, element]))
  for (const element of work.board.elements) {
    const old = before.get(element.id)
    if (old && !same({ ...old, updatedAt: '' }, { ...element, updatedAt: '' })) element.updatedAt = options.now
  }
  settleGroups(board, work)
  return work.board
}

/**
 * Stamp each group the batch changed, and bring a cleared one back to the
 * human when the change is substantive: its summary, status or links, or an
 * element in it that is new or says something new. Taking an element out is
 * tidying, and leaves it cleared.
 */
function settleGroups(board: Board, work: Working): void {
  const oldGroups = new Map(board.groups.map(entry => [entry.title, entry]))
  const oldElements = new Map(board.elements.map(element => [element.id, element]))
  const describe = (entry: BoardGroup) => [entry.summary ?? null, entry.status ?? null, entry.links ?? null]
  const responses: Board['groupResponses'] = {}
  for (const entry of work.board.groups) {
    const was = oldGroups.get(work.renamed.get(entry.title) ?? entry.title)
    const now = work.board.elements.filter(element => element.group === entry.title)
    const said = !was || !same(describe(was), describe(entry)) || now.some((element) => {
      const old = oldElements.get(element.id)
      return !old || old.group !== was.title || !same(old.content, element.content)
    })
    const removed = !!was && board.elements.some(element => element.group === was.title
      && !now.some(item => item.id === element.id))
    if (said || removed) entry.updatedAt = work.now
    else if (was?.updatedAt) entry.updatedAt = was.updatedAt
    const response = work.board.groupResponses[entry.title]
    if (response && !said) responses[entry.title] = response
  }
  work.board.groupResponses = responses
}

/** What a write has to touch: elements to upsert, ids to delete, and whether the board row itself changed. */
export function diffBoard(before: Board, after: Board) {
  const old = new Map(before.elements.map(element => [element.id, element]))
  const kept = new Set(after.elements.map(element => element.id))
  return {
    upserts: after.elements.filter(element => !same(old.get(element.id), element)),
    deletes: before.elements.filter(element => !kept.has(element.id)).map(element => element.id),
    boardChanged: before.headline !== after.headline || !same(before.groups, after.groups) || !same(before.folds, after.folds)
      || !same(before.groupResponses, after.groupResponses)
  }
}
