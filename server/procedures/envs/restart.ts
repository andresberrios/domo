import { z } from 'zod'
import * as dc from '../../lib/devcontainer'
import { getEnv, resolveContainerId, updateEnvStatus } from '../../lib/envs'

/**
 * Convenience: stop + start against the env's container. No image
 * rebuild — that's `POST /api/envs/run` (`devcontainer up`).
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), liveStatus: z.string().nullable() }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    const cid = await resolveContainerId(env)
    if (!cid) {
      throw createError({
        statusCode: 409,
        statusMessage: 'env has no container yet — provision it first via /api/envs/run',
      })
    }
    await dc.stop(cid).catch(() => {})
    await dc.start(cid)
    const after = await dc.inspect(cid)
    const live = after ? dc.toEnvLiveStatus(after.status) : 'missing'
    updateEnvStatus(env.id, live)
    return { ok: true, liveStatus: live }
  },
})
