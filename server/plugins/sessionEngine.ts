import { sessionEngine } from '../lib/sessionEngine/engine'

/**
 * Boot the in-process session engine (Decided #7).
 *
 * Replaces the old `electric.ts` plugin (which connected a pull-wake
 * runner to agents-server). The engine itself is created lazily per
 * session; on startup we just run the **reconcile pass**: any session
 * whose cached `status` is `active`/`pending-approval` flips to
 * `waiting`, any orphan `pending_diffs` row flips to `rejected` + a
 * `diff_decision { reason:'runtime restarted' }` event lands so the chat
 * card clears cross-device. No external service to wait on, no failure
 * mode that degrades the rest of Domo.
 *
 * On Nitro close we SIGTERM every live child so they don't outlive the
 * server.
 */
export default defineNitroPlugin((nitro) => {
  if (import.meta.prerender) return
  try {
    sessionEngine.bootReconcile()
  } catch (e) {
    console.error('[sessionEngine] boot reconcile failed:', e)
  }
  nitro.hooks.hook('close', async () => {
    await sessionEngine.stopAll().catch(() => {})
  })
})
