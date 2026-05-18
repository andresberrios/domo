<script setup lang="ts">
/** Email + password sign-in. */
const { fetchSession, refreshMe } = useAuth()

const email = ref('')
const password = ref('')
const pending = ref(false)
const errMsg = ref<string | null>(null)

function errText(e: unknown): string {
  const x = e as { data?: { message?: string }; statusMessage?: string }
  return x?.data?.message || x?.statusMessage || (e as Error).message
}

async function submit() {
  if (!email.value.trim() || !password.value) return
  pending.value = true
  errMsg.value = null
  try {
    const { user } = await apiClient.auth.login.call({
      email: email.value.trim(),
      password: password.value,
    })
    await fetchSession()
    await refreshMe()
    await navigateTo(user.status === 'active' ? '/' : '/pending')
  } catch (e) {
    errMsg.value = errText(e)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <DomoAuthCard title="Sign in" subtitle="Welcome back to Domo.">
    <form class="space-y-3" @submit.prevent="submit">
      <UFormField label="Email">
        <UInput
          v-model="email"
          type="email"
          autocomplete="username"
          placeholder="you@example.com"
        />
      </UFormField>
      <UFormField label="Password">
        <UInput
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="••••••••"
        />
      </UFormField>

      <p v-if="errMsg" class="text-sm text-error">
        {{ errMsg }}
      </p>

      <UButton type="submit" block color="primary" :loading="pending">
        Sign in
      </UButton>
    </form>

    <template #footer>
      <p class="text-sm text-muted">
        No account?
        <NuxtLink to="/register" class="text-primary hover:underline">
          Request access
        </NuxtLink>
      </p>
    </template>
  </DomoAuthCard>
</template>
