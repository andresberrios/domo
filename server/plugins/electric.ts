import { startElectricRuntime, stopElectricRuntime } from '../lib/electric/runtime'

/**
 * Bring the `claude-code-cli` runtime up with the Nitro server. Fire-and-
 * forget + non-fatal: a slow/absent agents-server must not block Domo
 * boot (projects/envs/workspace/git stay usable; session surface degrades).
 */
export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  void startElectricRuntime()
  nitro.hooks.hook('close', async () => {
    await stopElectricRuntime()
  })
})
