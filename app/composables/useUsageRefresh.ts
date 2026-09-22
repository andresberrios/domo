/**
 * One shared, debounced way to ask the usage poller to look again.
 *
 * The server enforces its own floor of one request a minute per provider
 * (`FLOOR_MS` in `server/lib/usage/poller.ts`) and a request inside that
 * window is accepted and silently dropped — no error, no new data, but still
 * a 200 the caller reads as success. Without a client-side mirror of that
 * floor, the sidebar's own "refresh on open" and its manual button raced each
 * other: opening the panel fired a request, and a manual click moments later
 * looked like it worked — a spinner, no error — while the server had already
 * discarded it. Sharing one cooldown across every caller (a module-scope
 * singleton, not a per-component ref) is what makes "click refresh" and "open
 * the panel" both mean the reading in front of you is as fresh as the server
 * allows, rather than a coin flip on which of two near-simultaneous requests
 * lands inside the floor.
 */
const REFRESH_FLOOR_MS = 60_000

// `canRefresh` has to be a ref a timer flips, not a computed comparing
// against `Date.now()`: a computed only re-runs when a *reactive* dependency
// it read changes, and `Date.now()` is not one. Written the other way, the
// comparison evaluates once (to `false`, the moment the cooldown starts) and
// then never again — the button reads as permanently disabled from the first
// refresh onward, since nothing ever nudges Vue into re-checking the clock.
function createState() {
  return { refreshing: ref(false), canRefresh: ref(true) }
}

let state = createState()
let cooldownTimer: ReturnType<typeof setTimeout> | null = null

export function useUsageRefresh() {
  const toast = useToast()

  async function refresh(): Promise<void> {
    if (state.refreshing.value || !state.canRefresh.value) return
    state.refreshing.value = true
    try {
      await $fetch('/api/usage/refresh', { method: 'POST' })
      state.canRefresh.value = false
      if (cooldownTimer) clearTimeout(cooldownTimer)
      cooldownTimer = setTimeout(() => {
        state.canRefresh.value = true
        cooldownTimer = null
      }, REFRESH_FLOOR_MS)
    } catch (error: any) {
      toast.add({ title: 'Could not refresh usage', description: error?.message, color: 'error' })
    } finally {
      state.refreshing.value = false
    }
  }

  return { refreshing: state.refreshing, canRefresh: state.canRefresh, refresh }
}

/** Drops the shared cooldown. For tests; the app never calls it. */
export function resetUsageRefreshForTests(): void {
  if (cooldownTimer) clearTimeout(cooldownTimer)
  cooldownTimer = null
  state = createState()
}
