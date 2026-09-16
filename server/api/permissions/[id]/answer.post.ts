import { acpManager } from '../../../lib/acp/manager'
import { listPermissions } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ optionId: string | null }>(event)
  const pending = await listPermissions(undefined, true)
  const permission = pending.find(p => p.id === id)
  if (!permission) throw createError({ statusCode: 404, statusMessage: 'Permission request is no longer pending' })
  await acpManager.answerPermission(permission.agentSessionId, id, body?.optionId ?? null, 'user')
  return { ok: true }
})
