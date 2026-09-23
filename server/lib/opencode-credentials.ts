import { join } from 'node:path'

/**
 * OpenCode 2 keeps its logins in sqlite, not in a JSON file.
 *
 * v1 read `~/.local/share/opencode/auth.json` and honoured
 * `OPENCODE_AUTH_CONTENT` to be handed one inline. v2 has neither: the store is
 * `~/.local/share/opencode/opencode.db`, and that variable is not in its binary
 * at all — passing it is a silent no-op. What is left is this database and
 * `OPENCODE_API_KEY`.
 *
 * Domo *reads* the database and never writes to it. The one row it wants sits
 * beside every OpenCode conversation the developer has ever had (`session_v2`,
 * `session_message`, `permission`, `instruction_blob`, …), which is why nothing
 * here hands the file itself to anything.
 */

/** A static console key, which outranks the login store and needs no database. */
export function opencodeApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.NUXT_OPENCODE_API_KEY || env.OPENCODE_API_KEY || null
}

/** Where OpenCode 2 keeps that store, resolved the way OpenCode itself does. */
export function opencodeDatabasePath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENCODE_DB) return env.OPENCODE_DB
  const dataHome = env.XDG_DATA_HOME || (env.HOME ? join(env.HOME, '.local', 'share') : null)
  return dataHome ? join(dataHome, 'opencode', 'opencode.db') : null
}

/** The console default the device flow authorises against. */
export const OPENCODE_CONSOLE_URL = 'https://opencode.ai/console'

export interface OpenCodeCredential {
  /** What a request to the console authenticates with. */
  token: string
  /** `api` needs no refresh and never expires; `oauth` is the device-flow login. */
  type: 'api' | 'oauth'
  /** Epoch milliseconds, for an `oauth` credential that carries one. */
  expires: number | null
  server: string
  orgId: string | null
  email: string | null
}

interface CredentialRow {
  value: string
}

/**
 * The active OpenCode console credential on this host, or null.
 *
 * The access token is read and used as it is. It is deliberately never
 * refreshed: OpenCode's refresh call replaces the stored refresh token with the
 * one the server answers with, so a second holder of the old token is relying
 * on the server not to invalidate it — the same rotation hazard Domo refuses to
 * copy a Claude login for. When the token has expired, say so and let the
 * developer's own OpenCode renew it.
 *
 * `node:sqlite` is imported lazily so an install that never runs OpenCode pays
 * neither the module nor its experimental warning.
 */
export async function readOpenCodeCredential(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeCredential | null> {
  const key = opencodeApiKey(env)
  if (key) {
    return { token: key, type: 'api', expires: null, server: OPENCODE_CONSOLE_URL, orgId: null, email: null }
  }
  const path = opencodeDatabasePath(env)
  if (!path) return null

  const { DatabaseSync } = await import('node:sqlite')
  let database: InstanceType<typeof DatabaseSync>
  try {
    database = new DatabaseSync(path, { readOnly: true })
  } catch {
    // No store yet, or a write-ahead log this process may not index. Either way
    // there is nothing to read, and opening for writing to find out is not
    // something Domo may do to somebody else's login store.
    return null
  }
  try {
    const row = database.prepare(
      'select value from credential where integration_id = ? and active = 1 order by time_updated desc limit 1'
    ).get('opencode') as CredentialRow | undefined
    return row ? parseCredential(row.value) : null
  } catch {
    return null
  } finally {
    database.close()
  }
}

/** The `credential.value` JSON, which is either a device-flow login or a key. */
export function parseCredential(value: string): OpenCodeCredential | null {
  let parsed: any
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  const metadata = parsed?.metadata
  const server = typeof metadata?.server === 'string' ? metadata.server : OPENCODE_CONSOLE_URL
  const orgId = typeof metadata?.orgID === 'string' ? metadata.orgID : null
  const email = typeof metadata?.email === 'string' ? metadata.email : null
  if (parsed?.type === 'oauth' && typeof parsed.access === 'string') {
    return {
      token: parsed.access,
      type: 'oauth',
      expires: typeof parsed.expires === 'number' ? parsed.expires : null,
      server,
      orgId,
      email
    }
  }
  if (parsed?.type === 'api' && typeof parsed.key === 'string') {
    return { token: parsed.key, type: 'api', expires: null, server, orgId, email }
  }
  return null
}

/** Whether this host has an OpenCode login at all, asked without keeping it. */
export async function hasOpenCodeCredential(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return !!await readOpenCodeCredential(env)
}
