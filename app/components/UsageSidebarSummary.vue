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
 * plain text, so the two windows read as shapes at a glance.
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
    return {
      ...entry,
      limits,
      provider: providerState(entry.id),
      fiveHour: fiveHourLimit(limits),
      weekly: weeklyLimit(limits)
    }
  }).filter(entry => entry.fiveHour || entry.weekly)
)

const { refresh } = useUsageRefresh()
const open = ref(false)

// Opening the panel is when a stale reading is most likely to be noticed, so
// it asks for a fresh one rather than waiting for the next scheduled poll.
// `refresh()` shares its cooldown with the panel's own manual button, so the
// two never race each other into the server's one-a-minute floor — see
// `useUsageRefresh` for why that sharing exists.
watch(open, (value) => {
  if (value) void refresh()
})
</script>

<template>
  <UPopover v-if="entries.length" v-model:open="open" :content="{ side: 'top', align: 'start' }">
    <UButton color="neutral" variant="ghost" size="xs" block class="justify-start gap-1">
      <UIcon name="i-lucide-gauge" class="size-3.5 shrink-0 text-dimmed" />
      <!--
        A grid rather than a wrapping flex row: Claude and Codex name labels
        differ in width, and in a flex row that shifts each provider's gauges
        by however many pixels its own name happens to be. A CSS grid sizes
        every column to the widest cell it contains across *both* rows, so the
        5-hour and weekly gauges line up under each other regardless of which
        name is longer. Providers that haven't reported one of the two windows
        yet still get an empty cell for it, or a missing gauge would shift
        every column after it out of alignment for that row only.

        Spacing is per-column margin rather than a uniform grid `gap`: the name
        should read as attached to its own gauges, and the two gauges as two
        separate things, so the gap after the name is smaller than the gap
        between the 5-hour and weekly gauges — a single `gap-x-*` cannot vary
        by column pair, but a margin on every cell of a given column can, and
        stays consistent between the two rows the same way the grid tracks do.
      -->
      <span class="grid min-w-0 flex-1 grid-cols-[auto_auto_auto] items-center gap-y-0.5">
        <template v-for="entry in entries" :key="entry.id">
          <span class="mr-0.5 text-[11px] text-dimmed">{{ entry.name }}</span>
          <UsageLimitGauge v-if="entry.fiveHour" class="mr-6" icon="i-lucide-timer" label="5-hour limit" :limit="entry.fiveHour" />
          <span v-else class="mr-6" />
          <UsageLimitGauge v-if="entry.weekly" icon="i-lucide-calendar-days" label="Weekly limit" :limit="entry.weekly" />
          <span v-else />
        </template>
      </span>
    </UButton>

    <template #content>
      <UsageSidebarPanel :entries="entries" />
    </template>
  </UPopover>
</template>
