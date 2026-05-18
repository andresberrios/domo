import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { domoHome } from '../lib/paths'

/**
 * nuxt-auth-utils seals the session cookie with `runtimeConfig.session
 * .password` (must be ≥32 chars). Domo is self-hosted and self-manages
 * everything under `$DOMO_HOME` — so rather than make the operator set
 * `NUXT_SESSION_PASSWORD`, generate a strong secret once and persist it
 * at `$DOMO_HOME/session-secret` (0600). Stable across restarts (sessions
 * survive), per-install (cookies aren't portable between deployments).
 *
 * Precedence: an explicit `NUXT_SESSION_PASSWORD` (already mapped into
 * `runtimeConfig.session.password` by nuxt.config) always wins; we only
 * fill in the auto-managed secret when it's empty. Runs as `00.*` so it's
 * applied before any request can touch a session.
 */
export default defineNitroPlugin(() => {
  if (import.meta.prerender) return

  const rc = useRuntimeConfig()
  if (rc.session.password) return // explicit env override — respect it

  const secretPath = join(domoHome(), 'session-secret')
  let secret: string
  try {
    secret = readFileSync(secretPath, 'utf8').trim()
  } catch {
    secret = ''
  }
  if (secret.length < 32) {
    secret = randomBytes(32).toString('hex') // 64 chars
    writeFileSync(secretPath, secret + '\n', { mode: 0o600 })
  }
  rc.session.password = secret
})
