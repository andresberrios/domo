import { environmentUpgradeStatus } from '../../../lib/dev-environments'

/** What a new container would change for this environment, asked of its current one. */
export default defineEventHandler(async (event) => {
  try {
    return await environmentUpgradeStatus(getRouterParam(event, 'id')!)
  } catch (error) {
    throw createError({
      statusCode: 404,
      statusMessage: error instanceof Error ? error.message : 'Could not read the environment.'
    })
  }
})
