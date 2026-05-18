<script setup lang="ts">
/**
 * First-run: create the admin account. Only reachable while no users
 * exist (the global middleware sends the first visitor here and everyone
 * else away). On success the admin is logged straight into the app.
 */
const { fetchSession, refreshBootstrap, refreshMe } = useAuth()

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
    await apiClient.auth.setup.call({
      name: name.value.trim(),
      email: email.value.trim(),
      password: password.value,
    })
    await fetchSession()
    await refreshBootstrap(true)
    await refreshMe()
    await navigateTo('/')
  } catch (e) {
    errMsg.value = errText(e)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <DomoAuthCard
    title="Create your admin account"
    subtitle="This is the first account on this Domo instance — it has full access and approves everyone who signs up next."
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

      <UButton
        type="submit"
        block
        color="primary"
        :loading="pending"
      >
        Create admin account
      </UButton>
    </form>
  </DomoAuthCard>
</template>
