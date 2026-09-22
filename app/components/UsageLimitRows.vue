<script setup lang="ts">
import type { UsageLimit, UsageProvider } from '~~/shared/types'

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

// Recomputed on a timer so "Resets in 3 hr 41 min" and "as of 12 min ago" stay
// true on a page left open — both are relative to now and neither row changes.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticker = setInterval(() => { now.value = Date.now() }, 30_000)
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})

const rows = computed(() => props.limits.map(limit => ({
  ...limit,
  label: limit.label || limitLabel(limit.limitId),
  reset: formatReset(limit.resetsAt, now.value),
  tone: usageTone(limit.usedPercent, limit.status),
  // A credits row is money, not a proportion of a window, so it says
  // "$15.95 of $100.00" where the others say "52%".
  amount: limit.amountLimit !== null || limit.amountUsed !== null
    ? `${formatAmount(limit.amountUsed, limit.currency)}${
      limit.amountLimit !== null ? ` of ${formatAmount(limit.amountLimit, limit.currency)}` : ''}`
    : null
})))

/** The oldest reading in the set: the whole panel is only as fresh as that. */
const staleness = computed(() => {
  const oldest = props.limits.reduce<string | null>(
    (worst, limit) => (!worst || limit.updatedAt < worst ? limit.updatedAt : worst),
    null
  )
  return formatStaleness(oldest, now.value)
})
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
      <p v-if="row.reset || row.status === 'rejected'" class="text-[11px] text-dimmed">
        <span v-if="row.status === 'rejected'" class="text-error">Limit reached</span>
        <span v-if="row.status === 'rejected' && row.reset"> · </span>
        <span v-if="row.reset">{{ row.reset }}</span>
      </p>
    </div>

    <p v-if="rows.length && staleness" class="text-[11px] text-dimmed">
      {{ staleness }}
    </p>
    <p
      v-if="rows.length && provider?.state === 'error' && provider.message"
      class="text-[11px] text-warning"
    >
      {{ provider.message }}
    </p>
  </div>
</template>
