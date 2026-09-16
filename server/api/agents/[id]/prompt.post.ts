import { acpManager } from '../../../lib/acp/manager'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ text?: string, content?: any[] }>(event)

  const content = body?.content?.length
    ? body.content
    : [{ type: 'text', text: (body?.text ?? '').trim() }]

  if (!content.length || (content.length === 1 && content[0]?.type === 'text' && !content[0].text)) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to send' })
  }

  void acpManager.promptInBackground(id, content)
  return { ok: true }
})
