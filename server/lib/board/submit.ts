import { BOARD_LIMITS, type Board, type BoardDraft, type BoardElement } from '../../../shared/types/board'
import { effectiveDraft, sortBoardElements } from '../../../shared/board'

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
  /** Elements the submission changed. */
  changed: string[]
}

/**
 * Apply `drafts` (by element id) to `board`. Drafts on elements that are gone,
 * or that no longer mean anything (see `effectiveDraft`), are dropped. Null
 * when nothing is left to send.
 */
export function applySubmission(board: Board, drafts: Map<string, BoardDraft>, now: string): Submission | null {
  const next = structuredClone(board)
  const lines: string[] = []
  const changed: string[] = []
  let group: string | null = null
  for (const element of sortBoardElements(next.elements, next.groups)) {
    const draft = effectiveDraft(element, drafts.get(element.id))
    if (!Object.keys(draft).length) continue
    // A coordinator relays by workstream, so each group's lines come under its name.
    if (element.group !== group && element.group) lines.push('', `${element.group}:`)
    group = element.group
    lines.push(describe(element, draft))
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
  if (!lines.length) return null
  const message = [
    `${BOARD_MESSAGE_PREFIX} The human responded on your status board (element ids in brackets):`,
    ...lines[0] === '' ? [] : [''],
    ...lines,
    '',
    'Act on this, and bring the board up to date with update_board: remove or update what is settled.'
  ].join('\n')
  return { board: next, message, changed }
}
