import { importBranch, resolveFromRef } from '../../../lib/dev-env/git-sync'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ branch?: string, from?: string | null }>(event)
  const branch = body?.branch?.trim()
  if (!branch) {
    throw createError({ statusCode: 400, statusMessage: 'Name the branch to write in the environment.' })
  }
  try {
    return await importBranch({
      environmentId: getRouterParam(event, 'id')!,
      branch,
      // Unlike an export there is no "send nothing" mode, so a blank `from`
      // means the branch's own name rather than null.
      from: resolveFromRef(branch, body.from)
    })
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not import the branch.'
    })
  }
})
