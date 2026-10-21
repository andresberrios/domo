import { sortBoardElements } from '../../../shared/board'
import type { Board } from '../../../shared/types/board'

/**
 * A board as an agent reads it: compact, in board order, the human's side
 * included and empty fields left out. Every byte is context it pays for.
 */
export function boardForAgent(board: Board) {
  return {
    ...board.headline ? { headline: board.headline } : {},
    ...board.groups.length ? { groups: board.groups } : {},
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
