import { listEnvironmentBranches } from '../../../lib/dev-env/git-sync'

export default defineEventHandler(async (event) => {
  try {
    return await listEnvironmentBranches(getRouterParam(event, 'id')!)
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not list the environment\'s branches.'
    })
  }
})
