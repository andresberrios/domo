import { submitBoard } from '../../../lib/board'
import { boardOwnerParam } from '../../../lib/board/route'

/** Send the human's drafts to the agent as one message. */
export default defineEventHandler(async (event) => {
  const result = await submitBoard(await boardOwnerParam(event))
  if (!result.submitted) throw createError({ statusCode: 400, statusMessage: 'Nothing to submit' })
  return result
})
