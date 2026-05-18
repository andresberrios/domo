/**
 * Client-side routing gate (UX only — real enforcement is the Nitro
 * `server/middleware/auth.ts`). Decides which of the bare auth screens vs
 * the app a visitor should be on:
 *
 *   no users yet      → /setup        (create the admin)
 *   not signed in     → /login        (or /register)
 *   signed in, pending → /pending     (waiting for admin approval)
 *   signed in, active  → the app
 *
 * Runs on every navigation; `bootstrap` is cached after the first probe,
 * `me` is re-fetched so an approval flips the pending user through
 * without a reload.
 */
const AUTH_PATHS = new Set(['/login', '/setup', '/register', '/pending'])

export default defineNuxtRouteMiddleware(async (to) => {
  const { loggedIn, fetchSession, refreshBootstrap, refreshMe } = useAuth()

  await fetchSession()
  const needsSetup = await refreshBootstrap()

  if (needsSetup) {
    return to.path === '/setup' ? undefined : navigateTo('/setup')
  }
  if (to.path === '/setup') {
    return navigateTo(loggedIn.value ? '/' : '/login')
  }

  if (!loggedIn.value) {
    if (to.path === '/login' || to.path === '/register') return
    return navigateTo('/login')
  }

  const user = await refreshMe()
  if (!user) {
    // Session sealed but the row is gone (deleted account) — drop & restart.
    await useUserSession().clear()
    return to.path === '/login' ? undefined : navigateTo('/login')
  }
  if (user.status === 'pending') {
    return to.path === '/pending' ? undefined : navigateTo('/pending')
  }
  // active
  if (AUTH_PATHS.has(to.path)) return navigateTo('/')
})
