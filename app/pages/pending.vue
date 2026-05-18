<script setup lang="ts">
/**
 * Holding screen for a signed-in but not-yet-approved account. Polls
 * `auth.me` (DB-fresh) every 5s — the moment the admin approves, status
 * flips to `active` and we drop the user into the app with no reload.
 */
const { me, refreshMe, logout } = useAuth()

let timer: ReturnType<typeof setInterval> | null = null

async function check() {
  const user = await refreshMe()
  if (user?.status === 'active') {
    await navigateTo('/')
  }
}

onMounted(() => {
  void check()
  timer = setInterval(check, 5000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <DomoAuthCard
    title="Waiting for approval"
    subtitle="Your account has been created. An admin needs to approve it before you can use Domo — this page updates automatically."
  >
    <div class="flex flex-col items-center gap-4 py-4">
      <UIcon
        name="i-lucide-loader-circle"
        class="size-8 text-primary animate-spin"
      />
      <p class="text-sm text-muted text-center">
        Signed in as <span class="font-medium text-default">{{ me?.email }}</span>
      </p>
      <UButton variant="ghost" size="sm" icon="i-lucide-log-out" @click="logout">
        Sign out
      </UButton>
    </div>
  </DomoAuthCard>
</template>
