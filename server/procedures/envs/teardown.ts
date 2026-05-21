import { z } from 'zod'

import * as dc from '../../lib/devcontainer'
import { getEnv, resolveContainerId, updateEnvFields } from '../../lib/envs'

/**
 * Stop + remove the env's container; keep the env row + the on-disk
 * workspace intact. The opposite end of `envs.delete`: tear down the
 * runtime without destroying the addressable env identity.
 *
 * Used by:
 * - The "Tear down" button on the **root env** overview (step 8). Root
 *   envs are auto-created per project, bind-mount `project.rootPath`,
 *   and can't be deleted — but they can be torn down to free the
 *   container (e.g. after rebuilding host-side, or to reclaim
 *   resources).
 * - Potentially: a future "stop + remove without deleting" affordance
 *   for non-root envs that want to nuke a container without losing
 *   the worktree. Not surfaced in v1 UI.
 *
 * Distinct from `envs.stop` — `stop` graceful-pauses the container
 * (`docker stop`, state survives); `teardown` is `docker rm --force`
 * and clears `container_id` so the next Start reprovisions.
 */
export default defineProcedure({
  input: z.object({ id: z.string() }),
  output: z.object({
    /** True if a container was found and removed (or was already
     * gone). False only if the env didn't exist. */
    tornDown: z.boolean(),
  }),
  handler: async ({ input }) => {
    const env = getEnv(input.id)
    if (!env) return { tornDown: false }

    const cid = await resolveContainerId(env)
    if (cid) {
      await dc.remove(cid).catch(() => {
        // Already gone or daemon unreachable — soft no-op; we still
        // clear the row's `container_id` below so the UI reflects the
        // no-container state.
      })
    }
    updateEnvFields(env.id, {
      containerId: null,
      // Drop the persisted config hash + path too: after a teardown
      // the next up is functionally a fresh build, so drift detection
      // should re-baseline rather than warn about the (still-valid)
      // last hash. Clearing `devcontainerPath` also makes the env
      // overview drop the "Using <path>" label until the next up
      // resolves it again — without this the label sticks around
      // describing config that nothing is currently running against.
      devcontainerPath: null,
      devcontainerConfigHash: null,
      status: 'stopped',
    })

    return { tornDown: true }
  },
})
