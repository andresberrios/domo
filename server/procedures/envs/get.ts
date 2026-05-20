import { z } from 'zod'
import { Env } from '../../lib/schemas'
import * as dc from '../../lib/devcontainer'
import { getEnv, resolveContainerId } from '../../lib/envs'

/**
 * Fetch one env by id with a fresh `docker inspect` snapshot for its
 * live status. Used by the env overview page.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: Env.nullable(),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) return null

    const cid = await resolveContainerId(env)
    if (!cid) return { ...env, liveStatus: null }
    const info = await dc.inspect(cid)
    return { ...env, liveStatus: info ? dc.toEnvLiveStatus(info.status) : 'missing' }
  },
})
