<script setup lang="ts">
import type { UsageProviderId } from '~~/shared/types'

/**
 * The account-wide view: one section per provider, and a way to ask again.
 *
 * Refreshing is fire-and-forget on purpose. The endpoint places the request and
 * the numbers arrive through Electric like every other row, so there is nothing
 * to await and nothing to merge — the bars simply move when the answer lands.
 */
const PROVIDERS: Array<{ id: UsageProviderId, name: string, icon: string }> = [
  { id: 'claude', name: 'Claude', icon: 'i-lucide-sparkles' },
  { id: 'codex', name: 'Codex', icon: 'i-lucide-terminal' }
]

const { forProvider, providerState } = useUsageLimits()
const toast = useToast()
const refreshing = ref(false)

async function refresh() {
  refreshing.value = true
  try {
    await $fetch('/api/usage/refresh', { method: 'POST' })
  } catch (error: any) {
    toast.add({ title: 'Could not refresh usage', description: error?.message, color: 'error' })
  } finally {
    refreshing.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-gauge" class="size-4 text-dimmed" />
        <h2 class="flex-1 text-sm font-semibold">
          Plan usage
        </h2>
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="Refresh usage limits"
          :loading="refreshing"
          @click="refresh"
        />
      </div>
    </template>

    <div class="grid gap-6 sm:grid-cols-2">
      <section v-for="entry in PROVIDERS" :key="entry.id" class="space-y-2">
        <p class="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
          <UIcon :name="entry.icon" class="size-3.5" />
          {{ entry.name }}
        </p>
        <UsageLimitRows :limits="forProvider(entry.id)" :provider="providerState(entry.id)" />
      </section>
    </div>
  </UCard>
</template>
