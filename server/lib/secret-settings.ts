import { SECRET_SETTING_KEYS, type AppSettings, type SecretSettingKey } from '../../shared/types'

/**
 * The credentials stored in Settings, mirrored in this process.
 *
 * Every reader of a key is synchronous and on a hot path — the voice backends,
 * the adapter spawn, the usage polls — so the row is not read on each use. The
 * mirror is filled by `getSettings()`, which boot calls once and every settings
 * read or write goes through. It is the server's own: one process, and the
 * browser never sees any of it.
 */
const mirror = new Map<SecretSettingKey, string>()

export function rememberSecretSettings(settings: Pick<AppSettings, SecretSettingKey>): void {
  for (const key of SECRET_SETTING_KEYS) {
    const value = settings[key]
    if (typeof value === 'string' && value.trim()) mirror.set(key, value.trim())
    else mirror.delete(key)
  }
}

/** A stored credential, or null. Each caller checks the environment first. */
export function storedSecret(key: SecretSettingKey): string | null {
  return mirror.get(key) ?? null
}

export function forgetSecretSettings(): void {
  mirror.clear()
}
