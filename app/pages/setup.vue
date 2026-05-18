<script setup lang="ts">
/**
 * First-run: create the admin account. Only reachable while no users
 * exist (the global middleware sends the first visitor here and everyone
 * else away). On success the admin is logged straight into the app.
 */
import { z } from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

const { fetchSession, refreshBootstrap, refreshMe } = useAuth()

// Mirrors the server `auth.setup` input so the user gets an inline
// reason (too-short password, bad email) before the request is sent.
const schema = z.object({
  name: z.string().trim().min(1, 'Enter your name'),
  email: z.string().trim().pipe(z.email('Enter a valid email address')),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})
type Schema = z.output<typeof schema>

const state = reactive({ name: '', email: '', password: '' })
const pending = ref(false)
const errMsg = ref<string | null>(null)

function errText(e: unknown): string {
  const x = e as { data?: { message?: string }; statusMessage?: string }
  return x?.data?.message || x?.statusMessage || (e as Error).message
}

async function onSubmit(event: FormSubmitEvent<Schema>) {
  pending.value = true
  errMsg.value = null
  try {
    await apiClient.auth.setup.call({
      name: event.data.name.trim(),
      email: event.data.email.trim(),
      password: event.data.password,
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
    <UForm
      :schema="schema"
      :state="state"
      class="space-y-3"
      @submit="onSubmit"
    >
      <UFormField label="Name" name="name">
        <UInput v-model="state.name" autocomplete="name" placeholder="Ada Lovelace" />
      </UFormField>
      <UFormField label="Email" name="email">
        <UInput
          v-model="state.email"
          type="email"
          autocomplete="username"
          placeholder="you@example.com"
        />
      </UFormField>
      <UFormField label="Password" name="password" hint="At least 8 characters">
        <UInput
          v-model="state.password"
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
    </UForm>
  </DomoAuthCard>
</template>
