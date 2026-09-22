import { importBranchIntoEnvironment } from '../../../lib/branch-import'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ branch?: string, from?: string | null }>(event)
  const branch = body?.branch?.trim()
  if (!branch) {
    throw createError({ statusCode: 400, statusMessage: 'Name the branch to write in the environment.' })
  }
  try {
    // The orchestrator, not `importBranch`: landing the refs is only half of
    // it, and an import the agents are never told about is inert.
    return await importBranchIntoEnvironment({
      environmentId: getRouterParam(event, 'id')!,
      branch,
      from: body.from
    })
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not import the branch.'
    })
  }
})
