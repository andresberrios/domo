import { cleanupEnvironment } from '../../../lib/dev-environments'

/**
 * Try again to remove the Docker resources a retirement could not.
 *
 * Domo does not retry on a timer: a removal Docker refuses is refused for a
 * reason that does not clear on its own, so the refusal is reported with the
 * container that is in the way named in it. This is what the reader calls once
 * they have dealt with that.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  try {
    const report = await cleanupEnvironment(id)
    return {
      ok: true,
      id,
      removed: report.removed.map(leftover => ({ kind: leftover.kind, name: leftover.name })),
      // Each error names the container in the way and the command that removes
      // it, so the caller can deal with it and come straight back here.
      leftovers: report.leftovers.map(({ kind, name, error }) => ({ kind, name, error }))
    }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: error instanceof Error ? error.message : 'Could not clean up after the environment.'
    })
  }
})
