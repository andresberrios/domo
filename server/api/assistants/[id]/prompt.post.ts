import { deliverToAssistant } from '../../../lib/assistants'
import type { MessageDelivery } from '../../../../shared/types'

const DELIVERIES: MessageDelivery[] = ['steer', 'queue', 'interrupt']

/** Say something to an assistant: its current session takes it, made if there is none. */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ text?: string, delivery?: string }>(event)
  const text = (body?.text ?? '').trim()
  if (!text) throw createError({ statusCode: 400, statusMessage: 'Nothing to send' })
  const delivery = DELIVERIES.find(mode => mode === body?.delivery) ?? 'steer'
  return deliverToAssistant(getRouterParam(event, 'id')!, {
    content: [{ type: 'text', text }],
    delivery,
    origin: 'user'
  })
})
