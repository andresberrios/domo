import { markBoardSeen } from '../../../lib/repo'
import { boardOwnerParam } from '../../../lib/board/route'

/** The human has looked at the board, so its changes are no longer new. */
export default defineEventHandler(async (event) => {
  await markBoardSeen(await boardOwnerParam(event))
  return { ok: true }
})
