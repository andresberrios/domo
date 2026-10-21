<script setup lang="ts">
import type { UsageLimit, UsageProvider, UsageProviderId } from '~~/shared/types'

/**
 * What the sidebar footer's gauge opens onto: one section per provider, plus a
 * way to ask again.
 *
 * Its own component rather than a slot inside `UsageSidebarSummary`, the same
 * reason `UsageMeterPanel` is split out of `UsageMeter` — it can be rendered,
 * and tested, without a popover and its teleport around it. Each section is
 * the same `UsageLimitRows` the composer's usage popover shows.
 */
defineProps<{
  entries: Array<{
    id: UsageProviderId
    name: string
    limits: UsageLimit[]
    provider: UsageProvider | null
  }>
}>()

// The cooldown is shared with every other refresh button: see `useUsageRefresh`.
const { refreshing, canRefresh, refresh } = useUsageRefresh()
</script>

<template>
  <div class="w-72 space-y-4 p-3">
    <div class="flex items-center gap-2">
      <p class="flex-1 text-[11px] font-medium uppercase tracking-wide text-dimmed">
        Plan usage
      </p>
      <UButton
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="ghost"
        size="xs"
        aria-label="Refresh usage limits"
        :title="canRefresh ? undefined : 'Checked moments ago — try again shortly'"
        :disabled="!canRefresh"
        :loading="refreshing"
        @click="refresh"
      />
    </div>
    <section v-for="entry in entries" :key="entry.id" class="space-y-2">
      <p class="text-[11px] font-medium uppercase tracking-wide text-dimmed">
        {{ entry.name }}
      </p>
      <UsageLimitRows :limits="entry.limits" :provider="entry.provider" compact />
    </section>
  </div>
</template>
