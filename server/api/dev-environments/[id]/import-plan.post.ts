import { previewImport } from '../../../lib/branch-import'

/**
 * What an import *would* do, so the modal can say it before the button is
 * pressed. The same `planImport()` the executor runs on, from the same reading
 * of the environment — the UI must not be able to promise something the server
 * would not do.
 *
 * The plan is not handed back in to execute: state moves, and the import
 * recomputes from what is true when it runs rather than trusting this.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ branch?: string, from?: string | null }>(event)
  const branch = body?.branch?.trim()
  if (!branch) {
    throw createError({ statusCode: 400, statusMessage: 'Name the branch to write in the environment.' })
  }
  try {
    return await previewImport({
      environmentId: getRouterParam(event, 'id')!,
      branch,
      from: body.from
    })
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not work out what the import would do.'
    })
  }
})
