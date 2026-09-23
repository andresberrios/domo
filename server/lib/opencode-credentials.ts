import { join } from 'node:path'

import { getSettings } from './settings'

/**
 * Where an OpenCode credential comes from, and why there are two answers.
 *
 * A **host** session needs nothing from Domo: OpenCode 2 reads its own login
 * out of `$HOME` and Domo passes no credential at all. A **container** session
 * cannot have that login, and there is no longer any way to hand it one. v1
 * read `~/.local/share/opencode/auth.json` and honoured `OPENCODE_AUTH_CONTENT`
 * to be given one inline; v2 has neither, and that variable is absent from its
 * binary, so setting it is a silent no-op.
 *
 * What replaced it is sqlite — `~/.local/share/opencode/opencode.db` — and
 * copying that across is the one design this must not have. The credential is
 * device-flow OAuth whose refresh call stores the refresh token the server
 * answers with over the old one, so two holders of one credential log each
 * other out and the loser is the developer's own machine: the hazard
 * `home-overlay.ts` refuses to mount `~/.claude` for, in a different file
 * format. Filtering the copy down to the credential rows does not help, because
 * the rotating token is the part being copied.
 *
 * So a container gets a **console service-account key** or nothing. That is the
 * same answer `claude setup-token` is for Claude Code — durable, revocable,
 * meant for a headless caller, with no refresh chain to fork — and OpenCode
 * lists it as a first-class auth method beside the device flow. The sqlite
 * store is still *read*, never written, for the one question it is honest
 * about: whether this host has a login at all.
 */

/** How the settings half of the key lookup is injected, so a unit test has no database. */
export type OpenCodeKeyLookup = () => Promise<string | null>

/** The key as the user typed it into Settings, which is the no-`.env` path. */
export async function settingsOpenCodeApiKey(): Promise<string | null> {
  return await getSettings().then(settings => settings.openCodeApiKey?.trim() || null).catch(() => null)
}

/**
 * The console key to authenticate with, or null.
 *
 * The environment wins, as it does for every other secret here: a key in
 * `.env` is the operator's deployment choice and the Settings field is the
 * convenience beneath it. Checking it first is also what keeps the database out
 * of the common path — and out of the unit layer, which has none.
 */
export async function resolveOpenCodeApiKey(
  env: NodeJS.ProcessEnv = process.env,
  stored: OpenCodeKeyLookup = settingsOpenCodeApiKey
): Promise<string | null> {
  return env.NUXT_OPENCODE_API_KEY || env.OPENCODE_API_KEY || await stored()
}

/** The environment half alone, for the paths that must not touch the database. */
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
 * The login `opencode auth login` left on *this host*, or null.
 *
 * Read-only in the strongest sense: the file is opened read-only, nothing is
 * ever written back, and the refresh token is never touched. It answers one
 * question — does this machine have an OpenCode login — for the Settings card,
 * and it is **not** what a request is authenticated with. The console rejects
 * this credential on the endpoints Domo polls (measured: 401 on the usage
 * endpoint with a device-flow access token, 200 with a service-account key),
 * and it cannot reach a container at all.
 *
 * `node:sqlite` is imported lazily so an install that never runs OpenCode pays
 * neither the module nor its experimental warning.
 */
export async function readOpenCodeLogin(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeCredential | null> {
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
    // Two integrations can hold one: `opencode` is the console account the
    // device flow writes, `opencode-go` the key a Go subscription is pasted in
    // as. The console account is preferred because it is what the console API
    // itself authenticates, and a Go key is an inference credential.
    const row = database.prepare(
      'select value from credential where integration_id in (?, ?) and active = 1'
      + " order by case integration_id when 'opencode' then 0 else 1 end, time_updated desc limit 1"
    ).get('opencode', 'opencode-go') as CredentialRow | undefined
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

/**
 * Whether OpenCode can authenticate at all, from either side.
 *
 * Two independent things, and the Settings card has to tell them apart: a
 * configured key is what container sessions and the usage poll use, while the
 * host's own login is what a host session runs on and Domo never touches.
 * Having one says nothing about having the other.
 */
export async function openCodeCredentialState(
  env: NodeJS.ProcessEnv = process.env,
  stored: OpenCodeKeyLookup = settingsOpenCodeApiKey
): Promise<{ key: boolean, hostLogin: boolean }> {
  const [key, login] = await Promise.all([resolveOpenCodeApiKey(env, stored), readOpenCodeLogin(env)])
  return { key: !!key, hostLogin: !!login }
}
