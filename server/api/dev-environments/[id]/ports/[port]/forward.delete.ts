import { unforwardEnvironmentPort } from '../../../../../lib/dev-environment-ports'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const port = Number(getRouterParam(event, 'port'))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw createError({ statusCode: 400, statusMessage: 'A valid TCP port is required.' })
  }
  await unforwardEnvironmentPort(id, port, String(getQuery(event).service ?? '') || null)
  return { ok: true }
})
