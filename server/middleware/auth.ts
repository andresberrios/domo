import { requireActiveUser } from '../lib/auth'

/**
 * The central auth gate. SPA route middleware is cosmetic — this is where
 * access is actually enforced, in front of the whole backend: every
 * `nuxt-procedures` call (`/procedures/**`), the streaming/WS endpoints
 * (`/api/**`), and the durable-stream reverse proxy (`/_agents/**`, which
 * carries the raw session transcript — must not be world-readable).
 *
 * Public (no auth): the auth procedures needed to bootstrap/sign in, plus
 * nuxt-auth-utils' own session endpoint (`useUserSession` fetch + the
 * `clear()` logout DELETE). `auth/me` is public *to the middleware* on
 * purpose — it runs its own `requireUser`, which lets a still-`pending`
 * user read their own status so the waiting screen can poll for approval.
 *
 * Everything else requires an **active** (admin-approved) user. Admin
 * procedures pass this gate, then re-check role via `requireAdmin`
 * (defence in depth).
 *
 * Only Domo's own backend is gated. The broad `/api/` prefix is NOT —
 * framework endpoints live there too (`/api/_auth/session`, the Nuxt
 * Icon bundle `/api/_nuxt_icon/*`) and must stay public so the auth
 * screens render. We instead enumerate Domo's own non-procedure
 * endpoints (the SSE/WS streams) explicitly.
 */
const GATED_PREFIXES = [
  '/procedures/',
  '/_agents/',
  '/api/coast-events',
  '/api/terminal',
  '/api/envs/',
  '/api/projects/',
]

const PUBLIC_PATHS = new Set([
  '/procedures/auth/bootstrap',
  '/procedures/auth/setup',
  '/procedures/auth/register',
  '/procedures/auth/login',
  '/procedures/auth/me',
])

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  const gated = GATED_PREFIXES.some((p) => path.startsWith(p))
  if (!gated) return

  if (PUBLIC_PATHS.has(path)) return

  await requireActiveUser(event)
})
