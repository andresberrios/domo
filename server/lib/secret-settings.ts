import { SECRET_SETTING_KEYS, type AppSettings, type SecretSettingKey } from '../../shared/types'

/**
 * The credentials stored in Settings, mirrored in this process.
 *
 * Every reader of a key is synchronous and on a hot path — the speech engines,
 * the adapter spawn, the usage polls — so the row is not read on each use. The
 * mirror is filled by `getSettings()`, which boot calls once and every settings
 * read or write goes through. It is the server's own: one process, and the
 * browser never sees any of it.
 */
const mirror = new Map<SecretSettingKey, string>()

/**
 * The server variables that set each credential ahead of Settings, in the order
 * they win. A developer override (`.env`): people set keys in the app, and the
 * app only ever says "set by the server's configuration" about these.
 *
 * `CODEX_API_KEY` counts as an OpenAI key because it is the same platform
 * credential under another name, but an explicitly OpenAI-named variable wins.
 */
export const SECRET_ENV: Record<SecretSettingKey, readonly string[]> = {
  geminiApiKey: ['NUXT_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openAiApiKey: ['NUXT_OPENAI_API_KEY', 'OPENAI_API_KEY', 'NUXT_CODEX_API_KEY', 'CODEX_API_KEY'],
  anthropicApiKey: ['NUXT_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  claudeCodeOauthToken: ['NUXT_CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  openCodeApiKey: ['NUXT_OPENCODE_API_KEY', 'OPENCODE_API_KEY'],
  // Not `GH_TOKEN`: that one is `gh`'s, for git, and may be a classic token Copilot refuses.
  copilotGithubToken: ['NUXT_COPILOT_GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN'],
  xaiApiKey: ['NUXT_XAI_API_KEY', 'XAI_API_KEY'],
  kyutaiApiKey: ['NUXT_KYUTAI_API_KEY']
}

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

/** The server's own value for a credential, or null. */
export function serverSecret(key: SecretSettingKey, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of SECRET_ENV[key]) {
    if (env[name]) return env[name]
  }
  return null
}

/** The credential in force: the server's override, else the one saved in Settings. */
export function secret(key: SecretSettingKey, env: NodeJS.ProcessEnv = process.env): string | null {
  return serverSecret(key, env) || storedSecret(key)
}

/** Where a credential in force comes from, for the settings view. */
export function secretSource(key: SecretSettingKey, env: NodeJS.ProcessEnv = process.env): 'server' | 'saved' | null {
  if (serverSecret(key, env)) return 'server'
  return storedSecret(key) ? 'saved' : null
}

export function forgetSecretSettings(): void {
  mirror.clear()
}
