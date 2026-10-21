<script setup lang="ts">
import type { UsageProviderId } from '~~/shared/types'

/**
 * The 5-hour and weekly windows per provider, small enough to live in the
 * sidebar footer.
 *
 * Limits are account-wide, so they should be visible from every page rather
 * than only from the one that happens to show a card — and both windows are
 * shown side by side, with no click needed, because a 5-hour window at 94% and
 * a weekly window at 11% are two different facts and hiding either behind a
 * popover means missing the one that isn't currently the worse of the two.
 * Each is a `UsageLimitGauge` — an icon, a bar and a percentage — rather than
 * plain text, so the two windows read as shapes at a glance. Opening the panel
 * mounts its `UsageLimitRows`, which ask for a fresher reading when the one on
 * screen is old.
 */
const PROVIDERS: Array<{ id: UsageProviderId, name: string }> = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'Codex' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'copilot', name: 'Copilot' }
]

const { forProvider, providerState } = useUsageLimits()

// Only providers that have something to say. An unconfigured Codex should not
// take a line in the footer to tell you it is not configured.
const entries = computed(() =>
  PROVIDERS.map((entry) => {
    const limits = forProvider(entry.id)
    return {
      ...entry,
      limits,
      provider: providerState(entry.id),
      fiveHour: fiveHourLimit(limits),
      weekly: weeklyLimit(limits)
    }
  }).filter(entry => entry.fiveHour || entry.weekly)
)
</script>

<template>
  <UPopover v-if="entries.length" :content="{ side: 'top', align: 'start' }">
    <UButton color="neutral" variant="ghost" size="xs" block class="justify-start">
      <!--
        A grid, so each column is as wide as its widest cell across every
        provider's row: the names share one left-aligned column, and the two
        gauge columns split what is left equally, with a gap between them. A
        provider missing one window still gets an empty cell for it, or every
        cell after it would shift a column.
      -->
      <span class="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 text-start">
        <template v-for="entry in entries" :key="entry.id">
          <span class="text-[11px] text-dimmed">{{ entry.name }}</span>
          <UsageLimitGauge v-if="entry.fiveHour" icon="i-lucide-timer" label="5-hour limit" :limit="entry.fiveHour" />
          <span v-else />
          <UsageLimitGauge v-if="entry.weekly" icon="i-lucide-calendar-days" :label="(entry.weekly.windowMinutes ?? 0) > 14 * 24 * 60 ? 'Monthly limit' : 'Weekly limit'" :limit="entry.weekly" />
          <span v-else />
        </template>
      </span>
    </UButton>

    <template #content>
      <UsageSidebarPanel :entries="entries" />
    </template>
  </UPopover>
</template>
