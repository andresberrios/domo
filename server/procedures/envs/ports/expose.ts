import { z } from 'zod'

import { getEnv } from '../../../lib/envs'
import * as portForwarder from '../../../lib/portForwarder'

/**
 * Expose an env's already-published inner port to `0.0.0.0:<externalPort>`
 * via a Domo-side TCP forwarder. The inner port must be declared in the
 * env's `devcontainer.json` `forwardPorts` (and so already published to
 * the host's loopback by `devcontainer up`); we layer a public listener
 * on top — no container recreate.
 *
 * Persisted to `env_external_ports`; restart-safe via the
 * `portForwarder` plugin's boot rebuild.
 */
export default defineProcedure({
  input: z.object({
    envId: z.string(),
    innerPort: z.number().int().positive(),
    externalPort: z.number().int().min(1).max(65535),
  }),
  output: z.object({ ok: z.boolean() }),
  handler: async ({ input }) => {
    const env = getEnv(input.envId)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    try {
      await portForwarder.expose(input.envId, input.innerPort, input.externalPort)
    } catch (e) {
      throw createError({
        statusCode: 409,
        statusMessage: e instanceof Error ? e.message : 'failed to bind external port',
      })
    }
    return { ok: true }
  },
})
