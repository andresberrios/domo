import { refreshEnvironmentPorts } from '../../../../lib/dev-environment-ports'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  try {
    return await refreshEnvironmentPorts(id)
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not inspect environment ports.'
    })
  }
})
