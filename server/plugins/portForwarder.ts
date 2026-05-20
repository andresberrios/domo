import * as portForwarder from '../lib/portForwarder'

/**
 * Boot the port forwarder (step 4 / Decided #9 amendment).
 *
 * On startup: rebuild every persisted external listener from the
 * `env_external_ports` SQLite table. Misses (env's container not
 * running yet, inner port not published) are logged and the row is
 * preserved — the env-run code path triggers a `rebindForEnv()`
 * after `devcontainer up` so listeners come up as soon as their
 * target is ready.
 *
 * On Nitro close: close every live listener.
 */
export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  // Don't await — let the rest of the boot proceed; forwarders are
  // best-effort independent of session-engine reconcile.
  portForwarder.rebuildAll().catch((e) => {
    console.error('[portForwarder] boot rebuild failed:', e)
  })
  nitro.hooks.hook('close', () => {
    portForwarder.stopAll()
  })
})
