import { z } from 'zod'
import { getSession } from '../../lib/sessions'
import { entityStreamPath } from '../../lib/electric/client'

/**
 * The entity's durable-stream path for a session, resolved server-side so
 * the browser never imports the full `@electric-ax/agents-runtime` entry
 * (its `createRuntimeServerClient` pulls `model-runner` →
 * `node:os/path/fs`, which breaks the client/production build). The chat
 * surface subscribes with the browser-safe `/client` entry using
 * `appendPathToUrl(location.origin + '/_agents', streamPath)`.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ streamPath: z.string() }),
  handler: async ({ input }) => {
    const session = getSession(input.id)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
    if (!session.entityId) {
      throw createError({
        statusCode: 409,
        statusMessage: 'session has no entity',
      })
    }
    return { streamPath: await entityStreamPath(session.entityId) }
  },
})
