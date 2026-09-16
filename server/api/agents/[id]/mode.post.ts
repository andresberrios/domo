import { acpManager } from '../../../lib/acp/manager'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ modeId: string }>(event)
  if (!body?.modeId) throw createError({ statusCode: 400, statusMessage: 'modeId is required' })
  await acpManager.setMode(id, body.modeId)
  return { ok: true }
})
