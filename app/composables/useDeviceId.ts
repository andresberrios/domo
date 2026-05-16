/**
 * Stable per-browser device id, persisted in localStorage. Powers the
 * left-rail new-output dot: `viewed_at_per_device` is keyed by this id so
 * "seen" state is per device, not global (design's per-device viewed-at).
 *
 * SPA-only app (ssr:false) so `localStorage` is always available on the
 * client; we still guard for the rare server-evaluated import.
 */
const STORAGE_KEY = 'domo:deviceId'

let cached: string | null = null

export function useDeviceId(): string {
  if (cached) return cached
  if (!import.meta.client) return 'server'
  let id = localStorage.getItem(STORAGE_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEY, id)
  }
  cached = id
  return id
}
