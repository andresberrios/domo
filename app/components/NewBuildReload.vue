<script setup lang="ts">
/**
 * Moves an open tab onto the build the server now serves. An update restarts
 * the server on a new build, and a tab left on the old one would run old code
 * against the new server, and fail on the first chunk it had not loaded yet.
 *
 * The build is Nuxt's app manifest: each build has an id, and
 * `builds/latest.json` names the one being served. It is asked every few
 * minutes, when the tab comes back, when the network does, after a failed
 * chunk, and every few seconds while the update row says the server is
 * restarting, so the tab moves within seconds of an update.
 */
const CHECK_MS = 5 * 60_000
const RESTART_POLL_MS = 3_000
/** How long to keep polling after a restart began: past the supervisor's rollback. */
const RESTART_POLL_FOR_MS = 3 * 60_000
const DECIDE_MS = 2_000
const TOAST_MS = 2_000

const nuxtApp = useNuxtApp()
const config = useRuntimeConfig()
const toast = useToast()
const { update } = useAppUpdate()

const outdated = ref(false)
let asked = false
let reloading = false

async function check() {
  if (outdated.value || !config.app.buildId) return
  try {
    const id = await fetchLatestBuildId(config.app)
    if (!id || id === config.app.buildId) return
    outdated.value = true
    // Nuxt's own handling: the next navigation loads the new build.
    await nuxtApp.hooks.callHook('app:manifest:update', { id, timestamp: Date.now() })
  } catch {
    // The server is restarting, or this is a development server: ask again later.
  }
}

function reload() {
  if (reloading) return
  reloading = true
  reloadNuxtApp({ force: true })
}

function decide() {
  if (!outdated.value || reloading) return
  const moment = reloadMoment({ held: reloadHeld(), dialogInput: dialogHasInput() })
  if (moment === 'wait') return
  if (moment === 'ask') {
    if (asked) return
    asked = true
    toast.add({
      id: 'new-build',
      title: 'Domo was updated',
      description: 'Reload for the new version when you are done here.',
      icon: 'i-lucide-refresh-cw',
      color: 'neutral',
      duration: 0,
      actions: [{ label: 'Reload', icon: 'i-lucide-refresh-cw', color: 'primary', variant: 'solid', onClick: reload }]
    })
    return
  }
  reloading = true
  toast.remove('new-build')
  toast.add({ title: 'Domo was updated', description: 'Reloading for the new version…', icon: 'i-lucide-refresh-cw', color: 'neutral', duration: TOAST_MS })
  setTimeout(() => reloadNuxtApp({ force: true }), TOAST_MS)
}

let restartPoll: ReturnType<typeof setInterval> | null = null
let restartPollEnds = 0
function pollThroughRestart() {
  restartPollEnds = Date.now() + RESTART_POLL_FOR_MS
  restartPoll ??= setInterval(() => {
    if (outdated.value || Date.now() > restartPollEnds) {
      clearInterval(restartPoll!)
      restartPoll = null
      return
    }
    void check()
  }, RESTART_POLL_MS)
}

watch(() => update.value?.state, (state) => {
  if (state === 'restarting') pollThroughRestart()
})
// The row comes back through Electric with the new commit once the server is up.
watch(() => update.value?.installedCommit, (commit, previous) => {
  if (commit && previous && commit !== previous) void check()
})
watch(outdated, decide)

function onVisible() {
  if (document.visibilityState === 'visible') void check()
}

let timers: ReturnType<typeof setInterval>[] = []
let unhook: (() => void) | null = null

onMounted(() => {
  // A development server rebuilds as it goes, and Vite reloads for itself.
  if (import.meta.dev && !import.meta.test) return
  timers = [setInterval(check, CHECK_MS), setInterval(decide, DECIDE_MS)]
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', check)
  unhook = nuxtApp.hook('app:chunkError', () => check())
})

onBeforeUnmount(() => {
  for (const timer of timers) clearInterval(timer)
  if (restartPoll) clearInterval(restartPoll)
  document.removeEventListener('visibilitychange', onVisible)
  window.removeEventListener('online', check)
  unhook?.()
})
</script>

<template>
  <span hidden />
</template>
