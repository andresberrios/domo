<script setup lang="ts">
// The bare auth screens (login/setup/register/pending) render WITHOUT the
// dashboard shell. `DomoAppShell` only mounts for a signed-in,
// admin-approved user — so its panel-state/data procedures never fire on
// the auth screens (an unauthenticated call would 401 → console error).
// The global route middleware does the redirecting; this just picks which
// chrome to wrap `<NuxtPage>` in.
const AUTH_PATHS = new Set(['/login', '/setup', '/register', '/pending'])
const route = useRoute()
const { loggedIn, isActive } = useAuth()
const showShell = computed(
  () => loggedIn.value && isActive.value && !AUTH_PATHS.has(route.path),
)
</script>

<template>
  <UApp>
    <NuxtLoadingIndicator color="var(--ui-primary)" />

    <!-- Bare auth screens — no dashboard chrome. -->
    <NuxtPage v-if="!showShell" />

    <DomoAppShell v-else />
  </UApp>
</template>
