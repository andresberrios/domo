import { upgradeProjectEnvironment } from '../../../lib/projects'

/** Give the environment a new container; its checkout, home and sessions carry over. */
export default defineEventHandler(async (event) => {
  try {
    const { environment, runtime, home, networks, stopped, stranded } = await upgradeProjectEnvironment(getRouterParam(event, 'id')!)
    return { environment, runtime, home, networks, stopped, stranded }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not upgrade the environment.'
    })
  }
})
