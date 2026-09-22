<script setup lang="ts">
import type { UsageLimit, UsageProvider, UsageProviderId } from '~~/shared/types'

/**
 * What the sidebar footer's gauge opens onto: one section per provider, plus a
 * way to ask again.
 *
 * Its own component rather than a slot inside `UsageSidebarSummary`, the same
 * reason `UsageMeterPanel` is split out of `UsageMeter` — it can be rendered,
 * and tested, without a popover and its teleport around it.
 */
const props = defineProps<{
  entries: Array<{
    id: UsageProviderId
    name: string
    limits: UsageLimit[]
    provider: UsageProvider | null
    /** The two windows the gauge shows, and the ones a refresh actually asks about. */
    fiveHour?: UsageLimit | null
    weekly?: UsageLimit | null
  }>
}>()

// Shared with `UsageSidebarSummary`'s own "refresh on open": see
// `useUsageRefresh` for why the cooldown has to be shared rather than kept
// here, next to the button that used to be the only thing driving it.
const { refreshing, canRefresh, refresh } = useUsageRefresh()

// Ticks the same way `UsageLimitRows`'s own staleness line does, so "as of …
// ago" stays true on a panel left open.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticker = setInterval(() => { now.value = Date.now() }, 30_000)
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})

/**
 * `UsageLimitRows`'s own "as of" line reports the *oldest* row in the whole
 * set on purpose — right for the full account page, where one button really
 * does refresh every row. Here a manual refresh (or opening the panel) only
 * ever touches the 5-hour and weekly windows the gauge shows: a per-model
 * weekly bucket or a credits balance updates on its own, much slower cadence,
 * and including it dragged the caption down to "2 hours ago" moments after a
 * refresh had just landed. This reports the freshest of the two windows the
 * refresh actually targets, so the caption means what a refresh promises.
 */
function staleness(entry: (typeof props.entries)[number]): string {
  const updatedAt = [entry.fiveHour?.updatedAt, entry.weekly?.updatedAt]
    .reduce<string | null>((freshest, value) => (value && (!freshest || value > freshest) ? value : freshest), null)
  return formatStaleness(updatedAt, now.value)
}
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
    <section v-for="entry in props.entries" :key="entry.id" class="space-y-2">
      <p class="text-[11px] font-medium uppercase tracking-wide text-dimmed">
        {{ entry.name }}
      </p>
      <UsageLimitRows :limits="entry.limits" :provider="entry.provider" compact hide-staleness />
      <p v-if="staleness(entry)" class="text-[11px] text-dimmed">
        {{ staleness(entry) }}
      </p>
    </section>
  </div>
</template>
