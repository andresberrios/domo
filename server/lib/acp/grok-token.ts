import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { adapterEnv, adapterLaunch } from './adapter-process'
import { RUNTIME_ROOT } from '../dev-env/runtime-volume'

/**
 * How a Grok session in a development environment signs in with this
 * computer's `grok login`, which is never copied there.
 *
 * The login's refresh token is single-use: a refresh returns a new one, and
 * the identity provider revokes the whole family when an old one comes back.
 * Two holders would log each other out. So the refresh token stays with this
 * computer's own Grok, and a container's Grok only ever gets a short-lived
 * *access* token: its `GROK_AUTH_PROVIDER_COMMAND` asks Domo
 * (`/api/internal/grok-token`), and Domo asks Grok here for the token it
 * would send itself (`_x.ai/auth/getBearerToken`), which it refreshes through
 * its own locked chain when it is about to expire. The container's Grok asks
 * again five minutes before expiry and on a 401. The token bills the same
 * Grok plan as the computer's own sessions.
 */

/**
 * What the container's Grok runs to sign in; it prints the answer of
 * `/api/internal/grok-token`. A function: this module and the runtime
 * volume's import each other.
 */
export function grokTokenCommand(): string {
  return `${RUNTIME_ROOT}/node/bin/node -e '`
    + 'fetch(process.env.DOMO_GROK_TOKEN_URL, { headers: { authorization: "Bearer " + process.env.DOMO_GROK_TOKEN } })'
    + '.then(async r => { const t = await r.text(); if (!r.ok) { console.error(t); process.exit(1) } process.stdout.write(t) })'
    + '.catch(e => { console.error(String(e)); process.exit(1) })\''
}

/** The issuer Grok needs beside an external token to treat it as a grok.com session. */
const ISSUER = 'https://auth.x.ai'
/** A token this close to expiry is asked for again: Grok here refreshes it in its last five minutes. */
const MARGIN_S = 10 * 60
const TIMEOUT_MS = 20_000

let cached: { token: string, expiresAt: number } | null = null
let asking: Promise<{ token: string, expiresAt: number } | null> | null = null

/** When a JWT expires, in seconds since the epoch; a token that is not one gets fifteen minutes. */
export function tokenExpiry(token: string, now = Date.now()): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload?.exp === 'number') return payload.exp
  } catch {
    /* not a JWT */
  }
  return Math.floor(now / 1000) + 15 * 60
}

/**
 * The answer a Grok external provider prints: the access token alone, never
 * the refresh token, with what is left of its life.
 */
export function providerAnswer(token: string, expiresAt: number, now = Date.now()): { access_token: string, expires_in: number, issuer: string } {
  return { access_token: token, expires_in: Math.max(0, expiresAt - Math.floor(now / 1000)), issuer: ISSUER }
}

/** This computer's Grok access token, or null when it has no `grok login`. */
export async function hostGrokAccessToken(): Promise<{ token: string, expiresAt: number } | null> {
  if (cached && cached.expiresAt - Date.now() / 1000 > MARGIN_S) return cached
  asking ??= ask().then((value) => {
    cached = value
    return value
  }).finally(() => {
    asking = null
  })
  return asking
}

/** Test seam. */
export function forgetHostGrokToken(): void {
  cached = null
}

async function ask(): Promise<{ token: string, expiresAt: number } | null> {
  const cwd = await mkdtemp(join(tmpdir(), 'domo-grok-token-'))
  // Its own login only: never the key, which is not a grok.com session.
  const { XAI_API_KEY: _key, ...env } = await adapterEnv('grok', false, undefined, undefined, async () => true)
  const launch = adapterLaunch('grok')
  const proc = spawn(launch.command, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const connection = acp.client({ name: 'domo' }).connect(acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    ))
    const answer = (async () => {
      const initialized = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
      } as any) as any
      if (initialized?._meta?.defaultAuthMethodId !== 'cached_token') return null
      // `{ result: { token } }` inside the JSON-RPC result, measured on 1.0.62.
      const answer = await connection.agent.request('_x.ai/auth/getBearerToken', {} as any) as any
      const value = answer?.result?.token ?? answer?.token
      const token = typeof value === 'string' && value ? value : null
      return token ? { token, expiresAt: tokenExpiry(token) } : null
    })()
    const gone = new Promise<never>((_, reject) => {
      proc.once('exit', code => reject(new Error(`grok exited (code ${code})`)))
      timer = setTimeout(() => reject(new Error('grok did not answer')), TIMEOUT_MS)
    })
    return await Promise.race([answer, gone])
  } finally {
    if (timer) clearTimeout(timer)
    proc.kill('SIGTERM')
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}
