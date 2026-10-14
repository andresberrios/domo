import { beginProjectEnvironmentUpgrade } from '../../../lib/projects'

/**
 * Give the environment a new container; its checkout, home and sessions carry
 * over. Answers at once, with the row marked `upgrading`: the outcome arrives
 * on the row (`status`, `lastError`, `lastUpgrade`).
 */
export default defineEventHandler(async (event) => {
  try {
    const { environment } = await beginProjectEnvironmentUpgrade(getRouterParam(event, 'id')!)
    return { environment }
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not upgrade the environment.'
    })
  }
})
