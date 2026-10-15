import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The Codex home a session will read its login from.
 *
 * A host session runs Codex with Domo's own `HOME`, and `CODEX_HOME` is not
 * passed through, so it is `~/.codex`. A container session gets the directory
 * `dev-environments.ts` bind-mounts at its `~/.codex`.
 */
export function codexHomeDir(inContainer: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ? join(env.HOME, '.codex') : null
  return inContainer ? env.NUXT_CODEX_CONFIG_DIR || home : home
}

/**
 * Whether Codex can log in with a ChatGPT subscription, asked without using it.
 *
 * Measured on codex-acp 1.13.1 / Codex 0.156.1: a ChatGPT login in `auth.json`
 * outranks `OPENAI_API_KEY` and `CODEX_API_KEY`, and `DEFAULT_AUTH_REQUEST` is
 * only tried when there is no account at all. That last case is the hazard:
 * the api-key login is *written into* `auth.json`, so once a ChatGPT login is
 * gone (an expired refresh, or codex-acp logging out after a refresh error)
 * every later Codex run in that home — the developer's own CLI included —
 * stays on API billing with no prompt. Domo therefore passes a key only when
 * there is no login to lose.
 *
 * The directory is shared with containers by a bind mount, never copied:
 * Codex refresh tokens are single-use, and it re-reads `auth.json` before
 * refreshing, so holders of one file cooperate where two copies would log
 * each other out.
 */
export async function hasCodexSubscriptionLogin(inContainer: boolean, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return await codexLogin(inContainer, env) === 'chatgpt'
}

/**
 * What Codex's own `auth.json` holds: a ChatGPT login, an API key that a
 * `codex login --with-api-key` (or a fallback run) saved there, or nothing.
 */
export async function codexLogin(inContainer: boolean, env: NodeJS.ProcessEnv = process.env): Promise<'chatgpt' | 'apikey' | null> {
  const dir = codexHomeDir(inContainer, env)
  if (!dir) return null
  try {
    const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as {
      auth_mode?: string
      OPENAI_API_KEY?: string | null
      tokens?: { refresh_token?: string, access_token?: string } | null
    }
    if (auth.auth_mode === 'apikey') return auth.OPENAI_API_KEY ? 'apikey' : null
    if (auth.tokens?.refresh_token || auth.tokens?.access_token) return 'chatgpt'
    return auth.OPENAI_API_KEY ? 'apikey' : null
  } catch {
    return null
  }
}

/**
 * The ChatGPT login's access token and account, read from `auth.json`, for a
 * call to the backend Codex itself calls. Null when there is no ChatGPT login,
 * or when the token expires within a minute.
 *
 * Read and never refreshed: the refresh token is single-use, and refreshing is
 * Codex's job, which re-reads the file first. An expired token is what a Codex
 * run renews, so the caller goes through Codex instead.
 */
export async function codexAccessToken(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): Promise<{ accessToken: string, accountId: string } | null> {
  const dir = codexHomeDir(false, env)
  if (!dir) return null
  try {
    const auth = JSON.parse(await readFile(join(dir, 'auth.json'), 'utf8')) as {
      auth_mode?: string
      tokens?: { access_token?: string, account_id?: string } | null
    }
    const accessToken = auth.tokens?.access_token
    const accountId = auth.tokens?.account_id
    if (auth.auth_mode === 'apikey' || !accessToken || !accountId) return null
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'))
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now + 60_000) return null
    return { accessToken, accountId }
  } catch {
    return null
  }
}
