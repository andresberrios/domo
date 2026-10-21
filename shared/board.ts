import type { BoardDraft, BoardElement, BoardGroup } from './types/board'

/**
 * Board rules both sides need: the UI to show a board as the server will
 * read it, the server to read a submission. Types only, so the browser does
 * not load the schema to use them.
 */

/** Done checklist items, the only ones the human acknowledges. */
export function doneItemIds(element: BoardElement): string[] {
  return element.content.kind === 'checklist'
    ? element.content.items.filter(item => item.status === 'done').map(item => item.id)
    : []
}

/**
 * The parts of a draft that still mean something against the element as it is
 * now: an option the agent has since removed, or an item no longer done, is
 * dropped rather than sent.
 */
export function effectiveDraft(element: BoardElement, draft: BoardDraft | null | undefined): BoardDraft {
  if (!draft) return {}
  const effective: BoardDraft = {}
  const content = element.content
  if (draft.answer && content.kind === 'question') {
    const known = new Set(content.options.map(option => option.id))
    let options = draft.answer.options.filter(id => known.has(id))
    if (!content.multiple) options = options.slice(0, 1)
    const text = content.allowCustom ? draft.answer.text?.trim() : undefined
    if (options.length || text) effective.answer = { options, ...text ? { text } : {} }
  }
  const reply = draft.reply?.trim()
  if (reply) effective.reply = reply
  if (draft.acknowledge && acknowledgeable(element) && !element.response.acknowledgedAt) effective.acknowledge = true
  if (draft.acknowledgeItems?.length) {
    const done = new Set(doneItemIds(element))
    const already = new Set(element.response.acknowledgedItems ?? [])
    const items = draft.acknowledgeItems.filter(id => done.has(id) && !already.has(id))
    if (items.length) effective.acknowledgeItems = items
  }
  if (draft.dismiss && !element.response.dismissedAt) effective.dismiss = true
  return effective
}

/** Whether the element as a whole takes an acknowledgement; a checklist's items take their own, a question an answer. */
export function acknowledgeable(element: BoardElement): boolean {
  return element.content.kind !== 'question' && element.content.kind !== 'checklist'
}

/** How many separate changes a draft holds, as the draft bar counts them. */
export function draftChangeCount(draft: BoardDraft): number {
  return (draft.answer ? 1 : 0)
    + (draft.reply ? 1 : 0)
    + (draft.acknowledge ? 1 : 0)
    + (draft.acknowledgeItems?.length ?? 0)
    + (draft.dismiss ? 1 : 0)
}

/**
 * Whether the human has dealt with an element, so it folds away: acknowledged
 * or dismissed, or a checklist whose every item is done and acknowledged. An
 * answered question stays in view until the agent acts on the answer.
 */
export function isCleared(element: BoardElement): boolean {
  if (element.response.dismissedAt || element.response.acknowledgedAt) return true
  if (element.content.kind === 'checklist' && element.content.items.length) {
    const acknowledged = new Set(element.response.acknowledgedItems ?? [])
    return element.content.items.every(item => item.status === 'done' && acknowledged.has(item.id))
  }
  return false
}

/** Elements in board order: the top first, then each group in turn. */
export function sortBoardElements(elements: BoardElement[], groups: BoardGroup[]): BoardElement[] {
  const titles = groups.map(group => group.title)
  const rank = (group: string | null) => group === null ? -1 : (titles.indexOf(group) + 1 || titles.length + 1)
  return [...elements].sort((a, b) => rank(a.group) - rank(b.group) || a.position - b.position || a.id.localeCompare(b.id))
}

/** An open question: not answered, not skipped. */
export function isOpenQuestion(element: BoardElement): boolean {
  return element.content.kind === 'question' && !element.response.answer && !element.response.dismissedAt
}

/**
 * What on an element is waiting for the human to look at: done items not yet
 * acknowledged, or the element itself when it is a decision or a warning not
 * yet acknowledged. Open questions are counted apart.
 */
export function unacknowledgedCount(element: BoardElement): number {
  const response = element.response
  if (response.dismissedAt) return 0
  const content = element.content
  if (content.kind === 'checklist') {
    const acknowledged = new Set(response.acknowledgedItems ?? [])
    return content.items.filter(item => item.status === 'done' && !acknowledged.has(item.id)).length
  }
  if (response.acknowledgedAt) return 0
  if (content.kind === 'decision') return 1
  if (content.kind === 'note' && (content.tone === 'warning' || content.tone === 'error')) return 1
  return 0
}

/** Whether an element is waiting for the human: the "Needs you" view. */
export function needsYou(element: BoardElement): boolean {
  if (isOpenQuestion(element) || unacknowledgedCount(element) > 0) return true
  return element.content.kind === 'checklist' && !element.response.dismissedAt
    && element.content.items.some(item => item.status === 'blocked')
}

/** What a group's header counts: open questions, and things to acknowledge. */
export function attention(elements: BoardElement[]) {
  return {
    questions: elements.filter(isOpenQuestion).length,
    unacknowledged: elements.reduce((sum, element) => sum + unacknowledgedCount(element), 0)
  }
}

/** Whether a group shows folded: as the human left it, else folded once it is done. */
export function isFolded(group: BoardGroup, folds: Record<string, boolean>): boolean {
  return folds[group.title] ?? group.status === 'done'
}
