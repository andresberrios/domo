<script setup lang="ts">
/**
 * Self-service signup. The account is created `pending` — the user lands
 * on the waiting screen until an admin approves it. No email is sent.
 */
const { fetchSession, refreshMe } = useAuth()

const name = ref('')
const email = ref('')
const password = ref('')
const pending = ref(false)
const errMsg = ref<string | null>(null)

function errText(e: unknown): string {
  const x = e as { data?: { message?: string }; statusMessage?: string }
  return x?.data?.message || x?.statusMessage || (e as Error).message
}

async function submit() {
  if (!name.value.trim() || !email.value.trim() || !password.value) return
  pending.value = true
  errMsg.value = null
  try {
    await apiClient.auth.register.call({
      name: name.value.trim(),
      email: email.value.trim(),
      password: password.value,
    })
    await fetchSession()
    await refreshMe()
    await navigateTo('/pending')
  } catch (e) {
    errMsg.value = errText(e)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <DomoAuthCard
    title="Request access"
    subtitle="Create an account. An admin will need to approve it before you can use Domo."
  >
    <form class="space-y-3" @submit.prevent="submit">
      <UFormField label="Name">
        <UInput v-model="name" autocomplete="name" placeholder="Ada Lovelace" />
      </UFormField>
      <UFormField label="Email">
        <UInput
          v-model="email"
          type="email"
          autocomplete="username"
          placeholder="you@example.com"
        />
      </UFormField>
      <UFormField label="Password" hint="At least 8 characters">
        <UInput
          v-model="password"
          type="password"
          autocomplete="new-password"
          placeholder="••••••••"
        />
      </UFormField>

      <p v-if="errMsg" class="text-sm text-error">
        {{ errMsg }}
      </p>

      <UButton type="submit" block color="primary" :loading="pending">
        Request access
      </UButton>
    </form>

    <template #footer>
      <p class="text-sm text-muted">
        Already have an account?
        <NuxtLink to="/login" class="text-primary hover:underline">
          Sign in
        </NuxtLink>
      </p>
    </template>
  </DomoAuthCard>
</template>
