import { clearedGroups, isCleared, sortBoardElements } from '../../../shared/board'
import type { Board } from '../../../shared/types/board'

/**
 * A board as an agent reads it: compact, in board order, the human's side
 * included and empty fields left out. Every byte is context it pays for.
 */
export function boardForAgent(board: Board) {
  return {
    ...board.headline ? { headline: board.headline } : {},
    ...board.groups.length
      ? {
          groups: board.groups.map(({ updatedAt: _, ...group }) => ({
            ...group,
            ...board.groupResponses[group.title]?.acknowledgedAt ? { cleared: true } : {},
            ...board.groupResponses[group.title]?.dismissedAt ? { dismissed: true } : {}
          }))
        }
      : {},
    elements: sortBoardElements(board.elements, board.groups).map((element) => {
      const { kind, title, body, ...fields } = element.content
      const human = element.response
      return {
        id: element.id,
        kind,
        ...element.group ? { group: element.group } : {},
        title,
        ...body ? { body } : {},
        ...fields,
        ...human.answer ? { answer: { options: human.answer.options, ...human.answer.text ? { text: human.answer.text } : {} } } : {},
        ...human.acknowledgedAt ? { acknowledged: true } : {},
        ...human.dismissedAt ? { dismissed: true } : {},
        ...human.acknowledgedItems?.length ? { acknowledgedItems: human.acknowledgedItems } : {},
        ...element.thread.length ? { thread: element.thread.map(entry => `${entry.from}: ${entry.text}`) } : {}
      }
    })
  }
}

/** Above these, the board is piling up and the agent hears so: below, it is left alone. */
const TIDY_CLEARED = 3
const TIDY_DONE = 4

/**
 * A nudge when the board is collecting what the human has finished with, or
 * finished groups they have not cleared yet. Null on a tidy board, so an agent
 * that keeps it hears nothing.
 */
export function tidyHint(board: Board): string | null {
  const gone = clearedGroups(board)
  const cleared = [
    ...board.groups.filter(group => gone.has(group.title)).map(group => `group "${group.title}"`),
    ...sortBoardElements(board.elements, board.groups).filter(element => !gone.has(element.group ?? '') && isCleared(element)).map(element => element.id)
  ]
  const done = board.groups.filter(group => group.status === 'done' && !gone.has(group.title)).length
  if (cleared.length >= TIDY_CLEARED) {
    return `The human has cleared ${cleared.join(', ')}: remove what no longer matters (remove, remove_group).`
  }
  if (done >= TIDY_DONE) {
    return `${done} groups are done. Remove any that no longer matter; the human clears the rest.`
  }
  return null
}
