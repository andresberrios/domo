<script setup lang="ts">
import type { UsageProviderId } from '~~/shared/types'

/**
 * The worst window per provider, small enough to live in the sidebar footer.
 *
 * Limits are account-wide, so they should be visible from every page rather
 * than only from the one that happens to show a card. "Worst" is the right
 * summary because it is the one that will stop work: a 5-hour window at 94% is
 * the fact, and the weekly window sitting at 11% beside it is not.
 */
const PROVIDERS: Array<{ id: UsageProviderId, name: string }> = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' }
]

const { forProvider, providerState } = useUsageLimits()

// Only providers that have something to say. An unconfigured Codex should not
// take a line in the footer to tell you it is not configured.
const entries = computed(() =>
  PROVIDERS.map((entry) => {
    const limits = forProvider(entry.id)
    return { ...entry, limits, provider: providerState(entry.id), worst: worstLimit(limits) }
  }).filter(entry => entry.worst)
)
</script>

<template>
  <UPopover v-if="entries.length" :content="{ side: 'top', align: 'start' }">
    <UButton color="neutral" variant="ghost" size="xs" block class="justify-start gap-2">
      <UIcon name="i-lucide-gauge" class="size-3.5 shrink-0 text-dimmed" />
      <span class="flex min-w-0 flex-1 items-center gap-2">
        <span v-for="entry in entries" :key="entry.id" class="flex items-center gap-1">
          <span class="text-[11px] text-dimmed">{{ entry.name }}</span>
          <span
            class="text-[11px] tabular-nums"
            :class="usageTone(entry.worst!.usedPercent, entry.worst!.status) === 'error'
              ? 'text-error'
              : usageTone(entry.worst!.usedPercent, entry.worst!.status) === 'warning' ? 'text-warning' : 'text-muted'"
          >{{ formatPercent(entry.worst!.usedPercent) }}</span>
        </span>
      </span>
    </UButton>

    <template #content>
      <div class="w-72 space-y-4 p-3">
        <section v-for="entry in entries" :key="entry.id" class="space-y-2">
          <p class="text-[11px] font-medium uppercase tracking-wide text-dimmed">
            {{ entry.name }}
          </p>
          <UsageLimitRows :limits="entry.limits" :provider="entry.provider" compact />
        </section>
      </div>
    </template>
  </UPopover>
</template>
