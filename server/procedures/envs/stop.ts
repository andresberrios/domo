import { z } from 'zod'
import * as dc from '../../lib/devcontainer'
import { getEnv, resolveContainerId, updateEnvStatus } from '../../lib/envs'

export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean(), liveStatus: z.string().nullable() }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) throw createError({ statusCode: 404, statusMessage: 'env not found' })
    const cid = await resolveContainerId(env)
    if (!cid) {
      // Nothing to stop — already missing. Surface as a soft no-op.
      updateEnvStatus(env.id, 'missing')
      return { ok: true, liveStatus: 'missing' }
    }
    await dc.stop(cid)
    const after = await dc.inspect(cid)
    const live = after ? dc.toEnvLiveStatus(after.status) : 'missing'
    updateEnvStatus(env.id, live)
    return { ok: true, liveStatus: live }
  },
})
