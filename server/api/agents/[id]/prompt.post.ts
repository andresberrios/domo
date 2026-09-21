import { acpManager } from '../../../lib/acp/manager'
import type { MessageDelivery } from '../../../../shared/types'

const DELIVERIES: MessageDelivery[] = ['steer', 'queue', 'interrupt']

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ text?: string, content?: any[], delivery?: string }>(event)

  const content = body?.content?.length
    ? body.content
    : [{ type: 'text', text: (body?.text ?? '').trim() }]

  if (!content.length || (content.length === 1 && content[0]?.type === 'text' && !content[0].text)) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to send' })
  }

  const delivery = DELIVERIES.find(mode => mode === body?.delivery)
  if (body?.delivery && !delivery) {
    throw createError({ statusCode: 400, statusMessage: `Unknown delivery: ${body.delivery}` })
  }

  // A person typing into the composer means "now", so the default is `steer`;
  // with nothing running that is a plain prompt either way.
  return acpManager.deliver(id, { content, delivery: delivery ?? 'steer', origin: 'user' })
})
