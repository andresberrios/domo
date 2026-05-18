import type { PublicUser } from '~~/server/lib/schemas'

/**
 * Auth state for the SPA. Wraps nuxt-auth-utils' `useUserSession` (sealed
 * cookie = identity only) and layers the DB-fresh `role`/`status` from the
 * `auth.me` procedure on top, plus the one-shot first-run `bootstrap`
 * probe. Shared via `useState` so the global route middleware, `app.vue`
 * shell gate, and the pages all read the same instance.
 *
 * The cookie deliberately doesn't carry role/status — `me` is the
 * authority, so an admin approve/reject lands without a re-login (the
 * `/pending` screen just re-fetches `me`).
 */
export function useAuth() {
  const { loggedIn, user: sessionUser, fetch: fetchSession, clear } =
    useUserSession()

  const me = useState<PublicUser | null>('auth:me', () => null)
  const needsSetup = useState<boolean | null>('auth:needsSetup', () => null)

  async function refreshBootstrap(force = false): Promise<boolean> {
    if (needsSetup.value !== null && !force) return needsSetup.value
    try {
      needsSetup.value = (await apiClient.auth.bootstrap.call()).needsSetup
    } catch {
      needsSetup.value = false
    }
    return needsSetup.value
  }

  async function refreshMe(): Promise<PublicUser | null> {
    if (!loggedIn.value) {
      me.value = null
      return null
    }
    try {
      me.value = (await apiClient.auth.me.call()).user
    } catch {
      me.value = null
    }
    return me.value
  }

  async function logout(): Promise<void> {
    // Null `me` FIRST: `isActive` flips false synchronously → `showShell`
    // false → the dashboard shell unmounts on the next flush, *before*
    // the awaited `clear()` round-trip. Otherwise a still-mounted shell
    // component refetches a gated procedure mid-logout and the (correct)
    // 401 surfaces as an uncatchable console error. `nextTick` guarantees
    // the unmount flush lands before we touch the network.
    me.value = null
    needsSetup.value = null
    await nextTick()
    await clear()
    await navigateTo('/login')
  }

  const isActive = computed(() => me.value?.status === 'active')
  const isAdmin = computed(
    () => isActive.value && me.value?.role === 'admin',
  )

  return {
    loggedIn,
    sessionUser,
    me,
    needsSetup,
    isActive,
    isAdmin,
    fetchSession,
    refreshBootstrap,
    refreshMe,
    logout,
  }
}
