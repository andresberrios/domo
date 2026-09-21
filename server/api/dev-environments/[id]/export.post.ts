import { exportBranch, resolveIntoBranch } from '../../../lib/dev-env/git-sync'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ branch?: string, into?: string | null }>(event)
  const branch = body?.branch?.trim()
  if (!branch) {
    throw createError({ statusCode: 400, statusMessage: 'Name the branch to export from the environment.' })
  }
  try {
    return await exportBranch({
      environmentId: getRouterParam(event, 'id')!,
      branch,
      // Absent means "the same branch name here"; null or blank means fetch only.
      into: resolveIntoBranch(branch, body.into)
    })
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not export the branch.'
    })
  }
})
