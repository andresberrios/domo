<script setup lang="ts">
import type { UsageLimit } from '~~/shared/types'

/**
 * One window's usage as a tiny icon, bar and percentage — small enough to sit
 * inline in the sidebar footer, where a full `UProgress` (block-level, sized
 * for a card) does not fit.
 *
 * The icon carries the meaning a compact "5h"/"wk" label used to (a clock for
 * a window that resets in hours, a calendar for one that resets in days), and
 * the bar makes the number a shape at a glance; the percentage stays for the
 * precision a bar alone can't give. `title` on the wrapper is what still
 * names the window for anyone not reading it as a shape.
 *
 * The bar itself grows to fill whatever width its grid cell gives it (see
 * `UsageSidebarSummary`'s `1fr` gauge columns) rather than sitting at a fixed
 * few pixels with empty sidebar width around it.
 */
const props = defineProps<{
  icon: string
  label: string
  limit: UsageLimit
}>()

const tone = computed(() => usageTone(props.limit.usedPercent, props.limit.status))
const textClass = computed(() => (
  tone.value === 'error' ? 'text-error' : tone.value === 'warning' ? 'text-warning' : 'text-muted'
))
const barClass = computed(() => (
  tone.value === 'error' ? 'bg-error' : tone.value === 'warning' ? 'bg-warning' : 'bg-primary'
))
const barWidth = computed(() => (
  props.limit.usedPercent === null ? 0 : Math.min(100, Math.max(0, props.limit.usedPercent))
))
</script>

<template>
  <span class="flex w-full min-w-0 items-center gap-1" :title="`${label}: ${formatPercent(limit.usedPercent)}`">
    <UIcon :name="icon" class="size-3 shrink-0 text-dimmed" />
    <span class="h-1 min-w-3 flex-1 overflow-hidden rounded-full bg-elevated">
      <span class="block h-full rounded-full" :class="barClass" :style="{ width: `${barWidth}%` }" />
    </span>
    <span class="shrink-0 text-[11px] tabular-nums" :class="textClass">{{ formatPercent(limit.usedPercent) }}</span>
  </span>
</template>
