import { z } from 'zod'
import * as dc from '../../lib/devcontainer'
import { getEnv, resolveContainerId, updateEnvStatus } from '../../lib/envs'

/**
 * Start an env's container. Idempotent: if it's already running we
 * just confirm; if a stopped container exists we `docker start`; if
 * no container exists yet the env hasn't been provisioned and the
 * caller should hit `POST /api/envs/run` (which calls
 * `devcontainer up`) instead.
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
    const info = await dc.inspect(cid)
    if (info?.status !== 'running') {
      await dc.start(cid)
    }
    const after = await dc.inspect(cid)
    const live = after ? dc.toEnvLiveStatus(after.status) : 'missing'
    updateEnvStatus(env.id, live)
    return { ok: true, liveStatus: live }
  },
})
