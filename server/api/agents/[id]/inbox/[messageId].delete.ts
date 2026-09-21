import { deleteInboxMessage } from '../../../../lib/repo'

export default defineEventHandler(async (event) => {
  const messageId = getRouterParam(event, 'messageId')!
  const removed = await deleteInboxMessage(messageId)
  // Gone means it was handed over while the user was looking at it, which is
  // not a failure — but it is not a deletion either, and the UI should say so.
  if (!removed) throw createError({ statusCode: 409, statusMessage: 'That message has already been delivered' })
  return { ok: true, id: messageId }
})
