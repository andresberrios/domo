import { clearBoardDrafts } from '../../../lib/repo'
import { boardOwnerParam } from '../../../lib/board/route'

/** Discard everything the human has not submitted. */
export default defineEventHandler(async (event) => {
  return { discarded: await clearBoardDrafts(await boardOwnerParam(event)) }
})
