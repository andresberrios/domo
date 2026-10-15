import { acpManager } from '../../../../lib/acp/manager'

/** Send what is queued for a working agent now: into its turn, or after cancelling it. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ delivery?: string }>(event)
  const delivery = body?.delivery ?? 'steer'
  if (delivery !== 'steer' && delivery !== 'interrupt') {
    throw createError({ statusCode: 400, statusMessage: `Unknown delivery: ${delivery}` })
  }
  return acpManager.deliverQueued(id, delivery)
})
