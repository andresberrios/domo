import type { AppSettingsView } from '~~/shared/types'

/**
 * The app's settings.
 *
 * Settings are the one thing the browser reads over HTTP rather than off an
 * Electric shape, and deliberately: the row holds a credential, and a synced
 * table streams to the browser whole. `AppSettingsView` is what comes back —
 * everything except the secret, plus whether each credential is configured.
 *
 * Every caller shares one request, whichever of these two it uses. Unkeyed,
 * `useFetch` keys on the call site, so each component that wanted settings
 * issued its own: a page with a handful of them asked ten times for the same
 * answer.
 */
const SETTINGS = { key: 'settings' } as const

/**
 * For a page that only consults a flag — whether a key is configured, which
 * SSH host to build a VS Code link from. Lazy, so nothing waits on it to
 * paint, and every reader must cope with `null` until it lands.
 */
export function useSettings() {
  return useFetch<AppSettingsView>('/api/settings', { ...SETTINGS, lazy: true })
}

/**
 * For a page that *edits* settings, which has to have them before it can save:
 * every one of those pages patches a whole field of the object, so saving
 * before the load would write back values it never read.
 */
export function useSettingsForm() {
  return useFetch<AppSettingsView>('/api/settings', SETTINGS)
}
