import { acpManager } from '../acp/manager'
import { deliverToAssistant } from '../assistants'
import { nowIso } from '../db'
import { assertSessionStartable } from '../acp/startable'
import {
  changeBoard,
  getAgentSession,
  getAgentSessionWithEnvironment,
  getAssistant,
  getBoard,
  listBoardDrafts
} from '../repo'
import type { AgentSession } from '../../../shared/types'
import { applyBoardOps, BoardEditError, parseBoardOps } from './ops'
import { applySubmission } from './submit'
import { boardForAgent, tidyHint } from './read'
import { isOpenQuestion } from '../../../shared/board'

export { BoardEditError }

/**
 * Whose board a session or assistant id names: an assistant's sessions all
 * share the assistant's. Null when there is no such session or assistant.
 */
export async function boardOwnerFor(id: string): Promise<string | null> {
  if (id.startsWith('as_')) return (await getAssistant(id)) ? id : null
  const session = await getAgentSession(id)
  if (!session) return null
  return session.assistantId ?? session.id
}

/**
 * The agent's edits to its own board, applied whole. Only a board's owner
 * writes it: a coordinator decides what of its workers' reports reaches the
 * human. Returns what an agent needs to hear back, and no more.
 */
export async function editBoard(caller: AgentSession, input: { ops?: unknown, replaceAll?: boolean }) {
  const ops = parseBoardOps(input.ops)
  if (!ops.length && !input.replaceAll) throw new BoardEditError('Pass ops: a list of edits.')
  const result = await changeBoard(caller.assistantId ?? caller.id, (board) => {
    const next = applyBoardOps(board, ops, { replaceAll: input.replaceAll === true, now: nowIso() })
    return { board: next, byAgent: true, result: next }
  })
  const board = result!
  const waiting = board.elements.filter(isOpenQuestion)
  const tidy = tidyHint(board)
  return {
    ok: true,
    elements: board.elements.length,
    ...board.groups.length ? { groups: board.groups.map(group => group.title) } : {},
    ...waiting.length ? { openQuestions: waiting.map(element => element.id) } : {},
    ...tidy ? { tidy } : {}
  }
}


export async function readBoardForAgent(ownerId: string) {
  return { ...ownerId.startsWith('as_') ? { assistantId: ownerId } : { agentId: ownerId }, ...boardForAgent(await getBoard(ownerId)) }
}

/**
 * Send the human's drafts to the agent: they land on the board and go out as
 * one message, queued behind a turn that is running like anything else said
 * to it.
 */
export async function submitBoard(ownerId: string): Promise<{ submitted: number, outcome?: string }> {
  // Checked before the board changes, so a refused delivery does not mark answers as given.
  if (!(await listBoardDrafts(ownerId)).size) return { submitted: 0 }
  if (!ownerId.startsWith('as_')) {
    const { session, environment } = await getAgentSessionWithEnvironment(ownerId)
    assertSessionStartable(session, environment, null, 'sending it your board changes')
  }
  const submission = await changeBoard(ownerId, (board, drafts) => {
    const applied = applySubmission(board, drafts, nowIso())
    // Drafts that meant nothing any more go too, or the bar would count them forever.
    if (!applied) return { board, byAgent: false, result: null, clearDrafts: [...drafts.keys()] }
    return { board: applied.board, byAgent: false, result: applied, clearDrafts: [...drafts.keys()] }
  })
  if (!submission) return { submitted: 0 }
  const content = [{ type: 'text', text: submission.message }]
  const delivered = ownerId.startsWith('as_')
    ? await deliverToAssistant(ownerId, { content, delivery: 'queue', origin: 'user' })
    : await acpManager.deliver(ownerId, { content, delivery: 'queue', origin: 'user' })
  return { submitted: submission.changed.length, outcome: delivered.outcome }
}
