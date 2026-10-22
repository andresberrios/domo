import { BOARD_LIMITS, type Board, type BoardDraft, type BoardElement } from '../../../shared/types/board'
import { effectiveDraft, effectiveGroupDraft, groupDraftKey, sortBoardElements } from '../../../shared/board'

/**
 * The human's drafts, submitted: what they do to the board, and the one
 * message that tells the agent about all of them. Pure, like the agent's ops.
 */

export const BOARD_MESSAGE_PREFIX = '[Status board]'

const KIND_LABEL: Record<BoardElement['content']['kind'], string> = {
  question: 'Question',
  checklist: 'Checklist',
  decision: 'Decision',
  note: 'Note',
  links: 'Links',
  metrics: 'Metrics'
}

function quote(text: string): string {
  return JSON.stringify(text)
}

/** A reply of several lines, indented under its bullet. */
function block(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n')
}

function describe(element: BoardElement, draft: BoardDraft): string {
  const parts: string[] = []
  const content = element.content
  if (draft.answer && content.kind === 'question') {
    const chosen = draft.answer.options.map((id) => {
      const option = content.options.find(item => item.id === id)
      return `${quote(option?.label ?? id)} [${id}]`
    })
    if (chosen.length) parts.push(`answered ${chosen.join(', ')}`)
    if (draft.answer.text) parts.push(`${chosen.length ? 'and added' : 'answered in their own words'}:\n${block(draft.answer.text)}`)
  }
  if (draft.acknowledgeItems?.length && content.kind === 'checklist') {
    const names = draft.acknowledgeItems.map((id) => {
      const item = content.items.find(entry => entry.id === id)
      return `${quote(item?.text ?? id)} [${id}]`
    })
    parts.push(`acknowledged done ${names.join(', ')}`)
  }
  if (draft.acknowledge) parts.push('acknowledged')
  if (draft.dismiss) parts.push(content.kind === 'question' ? 'skipped (dismissed)' : 'dismissed')
  if (draft.reply) parts.push(`replied:\n${block(draft.reply)}`)
  return `- ${KIND_LABEL[content.kind]} ${quote(content.title)} [${element.id}]: ${parts.join('; ')}`
}

export interface Submission {
  board: Board
  message: string
  /** Draft keys the submission acted on: element ids, and `groupDraftKey`s. */
  changed: string[]
}

/**
 * Apply `drafts` (by element id, or `groupDraftKey` for a group) to `board`.
 * Drafts on elements or groups that are gone, or that no longer mean anything
 * (see `effectiveDraft`), are dropped. Null when nothing is left to send.
 */
export function applySubmission(board: Board, drafts: Map<string, BoardDraft>, now: string): Submission | null {
  const next = structuredClone(board)
  const changed: string[] = []
  // A coordinator relays by workstream, so each group's lines come under its name.
  const sections = new Map<string | null, string[]>([[null, []], ...next.groups.map(entry => [entry.title, []] as [string, string[]])])
  const section = (title: string | null) => sections.get(title) ?? sections.set(title, []).get(title)!
  for (const entry of next.groups) {
    const key = groupDraftKey(entry.title)
    const draft = effectiveGroupDraft(entry, next.groupResponses[entry.title], drafts.get(key))
    if (!Object.keys(draft).length) continue
    section(entry.title).push(`- Group ${quote(entry.title)}: ${draft.dismiss ? 'dismissed' : 'cleared as done (they have read its outcome)'}`)
    changed.push(key)
    next.groupResponses = { ...next.groupResponses, [entry.title]: draft.dismiss ? { dismissedAt: now } : { acknowledgedAt: now } }
  }
  for (const element of sortBoardElements(next.elements, next.groups)) {
    const draft = effectiveDraft(element, drafts.get(element.id))
    if (!Object.keys(draft).length) continue
    section(element.group).push(describe(element, draft))
    changed.push(element.id)
    const response = { ...element.response }
    if (draft.answer) response.answer = { ...draft.answer, at: now }
    if (draft.acknowledge) response.acknowledgedAt = now
    if (draft.dismiss) response.dismissedAt = now
    if (draft.acknowledgeItems) response.acknowledgedItems = [...response.acknowledgedItems ?? [], ...draft.acknowledgeItems]
    element.response = response
    if (draft.reply) element.thread = [...element.thread, { from: 'user' as const, text: draft.reply, at: now }].slice(-BOARD_LIMITS.thread)
    element.updatedAt = now
  }
  if (!changed.length) return null
  const lines: string[] = []
  for (const [title, entries] of sections) {
    if (!entries.length) continue
    if (title !== null) lines.push('', `${title}:`)
    lines.push(...entries)
  }
  const message = [
    `${BOARD_MESSAGE_PREFIX} The human responded on your status board (element ids in brackets):`,
    ...lines[0] === '' ? [] : [''],
    ...lines,
    '',
    'Act on this, and bring the board up to date with update_board: remove what is settled, and a group they cleared or dismissed once nothing in it still matters.'
  ].join('\n')
  return { board: next, message, changed }
}
