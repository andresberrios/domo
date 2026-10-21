<script setup lang="ts">
import { useNow } from '@vueuse/core'
import type { UsageLimit, UsageProvider } from '~~/shared/types'
import { currentUsageLimit } from '~~/shared/usage-limits'

/**
 * One provider's plan limits, as a list of labelled bars.
 *
 * The three empty states are deliberately different, because they call for
 * different things from the reader: "not configured" is a setting to change,
 * "error" is something broken, and "nothing yet" is just waiting. Collapsing
 * them into one blank panel is how a misconfigured install looks identical to a
 * working one with nothing to say.
 */
const props = defineProps<{
  limits: UsageLimit[]
  provider?: UsageProvider | null
  /** Rendered smaller inside a popover than on the home page. */
  compact?: boolean
}>()

// Every usage view is one of these, so this is where opening one asks for a
// fresher reading. The server looks only if its last look is a few minutes
// old or a window has reset since, so opening a popover twice asks nothing.
const { refreshIfStale } = useUsageRefresh()
const providerId = computed(() => props.limits[0]?.provider ?? props.provider?.provider ?? null)
onMounted(() => {
  if (providerId.value) void refreshIfStale(providerId.value)
})

// Recomputed on a timer so "Resets in 3 hr 41 min" and "as of 12 min ago" stay
// true on a page left open — both are relative to now and neither row changes.
// The same timer turns a window whose reset has passed into a reset one.
const now = useNow({ interval: 30_000 })

const current = computed(() => visibleLimits(props.limits).map(limit => currentUsageLimit(limit, now.value.getTime())))

/**
 * How fresh the panel is: the freshest of the 5-hour and weekly windows,
 * which every poll reads. A row that only some source reports (a per-model
 * week, a credits balance) can be much older, and says so on its own line
 * instead of dragging the whole panel's caption down.
 */
const freshest = computed(() => {
  const polled = [fiveHourLimit(current.value), weeklyLimit(current.value)].filter(limit => limit !== null)
  return (polled.length ? polled : current.value)
    .reduce<string | null>((best, limit) => (!best || limit.updatedAt > best ? limit.updatedAt : best), null)
})
const caption = computed(() => formatStaleness(freshest.value, now.value.getTime()))

/** Older than the panel's caption by this much, a row gives its own age. */
const ROW_LAG_MS = 10 * 60_000

const rows = computed(() => current.value.map((limit) => {
  const lagging = freshest.value !== null && Date.parse(freshest.value) - Date.parse(limit.updatedAt) > ROW_LAG_MS
  return {
    ...limit,
    state: limitState(limit),
    reset: limit.resetPassed ? 'Reset, not re-read yet' : formatReset(limit.resetsAt, now.value.getTime()),
    staleness: lagging ? formatStaleness(limit.updatedAt, now.value.getTime()) : '',
    tone: usageTone(limit.usedPercent, limit.status),
    // A credits row is money, not a proportion of a window, so it says
    // "$15.95 of $100.00" where the others say "52%".
    amount: limit.amountLimit !== null || limit.amountUsed !== null
      ? `${formatAmount(limit.amountUsed, limit.currency)}${
        limit.amountLimit !== null ? ` of ${formatAmount(limit.amountLimit, limit.currency)}` : ''}`
      : null
  }
}))
</script>

<template>
  <div class="space-y-3">
    <UAlert
      v-if="provider?.state === 'unconfigured'"
      color="neutral"
      variant="subtle"
      icon="i-lucide-key-round"
      :description="provider.message ?? 'No account is configured for this provider.'"
      :ui="{ description: 'text-xs' }"
    />
    <UAlert
      v-else-if="provider?.state === 'error' && !rows.length"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="provider.message ?? 'The last check failed.'"
      :ui="{ description: 'text-xs' }"
    />

    <p v-if="!rows.length && provider?.state !== 'unconfigured' && provider?.state !== 'error'" class="text-xs text-dimmed">
      No readings yet.
    </p>

    <div v-for="row in rows" :key="row.limitId" class="space-y-1">
      <div class="flex items-baseline gap-2">
        <span class="min-w-0 flex-1 truncate" :class="compact ? 'text-xs font-medium' : 'text-sm font-medium'">
          {{ row.label }}
        </span>
        <span v-if="row.state" class="shrink-0 text-xs text-muted">{{ row.state }}</span>
        <span v-if="row.amount" class="shrink-0 text-xs tabular-nums text-muted">{{ row.amount }}</span>
        <span
          v-if="row.usedPercent !== null"
          class="shrink-0 text-xs tabular-nums"
          :class="row.tone === 'error' ? 'text-error' : row.tone === 'warning' ? 'text-warning' : 'text-muted'"
        >{{ formatPercent(row.usedPercent) }}</span>
      </div>
      <UProgress
        v-if="row.usedPercent !== null"
        :model-value="Math.min(100, row.usedPercent)"
        :color="row.tone"
        size="sm"
      />
      <p v-if="row.reset || row.staleness || row.status === 'rejected'" class="text-[11px] text-dimmed">
        <span v-if="row.status === 'rejected'" class="text-error">Limit reached</span>
        <span v-if="row.status === 'rejected' && (row.reset || row.staleness)"> · </span>
        {{ [row.reset, row.staleness].filter(Boolean).join(' · ') }}
      </p>
    </div>

    <p v-if="rows.length && caption" class="text-[11px] text-dimmed">
      {{ caption }}
    </p>
    <p
      v-if="rows.length && provider?.state === 'error' && provider.message"
      class="text-[11px] text-warning"
    >
      {{ provider.message }}
    </p>
  </div>
</template>
