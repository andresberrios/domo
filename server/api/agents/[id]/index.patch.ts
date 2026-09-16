import { updateAgentSession } from '../../../lib/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ title?: string, archived?: boolean }>(event)
  const session = await updateAgentSession(id, body ?? {})
  if (!session) throw createError({ statusCode: 404, statusMessage: 'Agent session not found' })
  return session
})
