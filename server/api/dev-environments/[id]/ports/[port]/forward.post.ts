import { forwardEnvironmentPort } from '../../../../../lib/dev-environment-ports'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const port = Number(getRouterParam(event, 'port'))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw createError({ statusCode: 400, statusMessage: 'A valid TCP port is required.' })
  }
  try {
    // Which container the port is in, when it is not the environment itself.
    const service = String(getQuery(event).service ?? '') || null
    return await forwardEnvironmentPort(id, port, service)
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not forward the port.'
    })
  }
})
