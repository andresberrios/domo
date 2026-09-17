import { stopEnvironment } from '../../../lib/dev-environments'

export default defineEventHandler(async (event) => {
  try {
    return await stopEnvironment(getRouterParam(event, 'id')!)
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not stop environment.'
    })
  }
})
