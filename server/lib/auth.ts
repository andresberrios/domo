/**
 * Server-side auth guards — the real security boundary.
 *
 * The SPA route middleware is cosmetic (a client can lie); these run in
 * Nitro and gate the API. The sealed session cookie carries identity
 * only, so every guard re-reads the live `users` row: a deleted user's
 * stale cookie fails, and an admin approve/reject lands on the user's
 * very next request with no re-login.
 *
 * Used both centrally (the `server/middleware/auth.ts` gate over the
 * procedures + Domo's own `/api/*` SSE/WS endpoints, incl. `/api/live`)
 * and per-procedure for role checks (`requireAdmin`) as defence-in-depth.
 */
import type { H3Event } from 'h3'
import { getUserById, type UserRow } from './users'

export async function requireUser(event: H3Event): Promise<UserRow> {
  const { user } = await requireUserSession(event)
  const row = getUserById(user.id)
  if (!row) {
    // Account deleted out from under a still-sealed cookie — drop it.
    await clearUserSession(event)
    throw createError({ statusCode: 401, statusMessage: 'Not authenticated' })
  }
  return row
}

export async function requireActiveUser(event: H3Event): Promise<UserRow> {
  const row = await requireUser(event)
  if (row.status !== 'active') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Account pending admin approval',
    })
  }
  return row
}

export async function requireAdmin(event: H3Event): Promise<UserRow> {
  const row = await requireActiveUser(event)
  if (row.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'Admin only' })
  }
  return row
}

/** Live row for the current session, or null if unauthenticated/gone. */
export async function getOptionalUser(event: H3Event): Promise<UserRow | null> {
  const session = await getUserSession(event)
  if (!session.user) return null
  return getUserById(session.user.id)
}
