import { z } from 'zod'

import { getEnv } from '../../../lib/envs'
import * as portForwarder from '../../../lib/portForwarder'

/**
 * Stop the external listener for an env's inner port and forget the
 * mapping. The inner port stays published to `127.0.0.1:<random>` —
 * only the public-side exposure goes away.
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    innerPort: z.number().int().positive(),
  }),
  output: z.object({ ok: z.boolean() }),
  handler: ({ input }) => {
    const env = getEnv(input.envId)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    portForwarder.unexpose(input.envId, input.innerPort)
    return { ok: true }
  },
})
