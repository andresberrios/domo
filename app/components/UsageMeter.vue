<script setup lang="ts">
import type { AgentUsage, UsageProviderId } from '~~/shared/types'

/**
 * A session's context window, as a gauge in the composer's footer, with the
 * account's limits behind it.
 *
 * The footer is one line on a phone, so the gauge is a ring (and the number
 * beside it from `sm` up); everything that needs words is in
 * `UsageMeterPanel`, which opens on hover where there is a pointer and on a
 * tap where there is not. With no reading at all it renders nothing rather
 * than a zero: a fresh session has not reported yet, and "0%" would be a
 * claim rather than a gap.
 */
const props = defineProps<{
  usage: AgentUsage | null
  /** Whose plan limits to show under the context bar. */
  provider?: UsageProviderId
}>()

const isTouch = useIsTouch()

const context = computed(() => props.usage?.context ?? null)
const percent = computed(() => (context.value ? percentOf(context.value.used, context.value.size) : null))
const tone = computed(() => usageTone(percent.value))

/** Only once a turn has ended, and only from an adapter that reports one. */
const cost = computed(() => props.usage?.cost ?? null)

const label = computed(() => {
  if (!context.value) return ''
  // A model whose window Domo does not know gets a token count and no ring: a
  // percentage needs a denominator, and inventing one would be a lie.
  return percent.value === null ? formatTokens(context.value.used) : formatPercent(percent.value)
})

/** The ring's circumference at r = 6, for the dash that fills it. */
const RING = 2 * Math.PI * 6
</script>

<template>
  <UPopover
    v-if="context"
    :mode="isTouch ? 'click' : 'hover'"
    :open-delay="150"
    :content="{ side: 'top', align: 'start' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      class="shrink-0 gap-1 px-1.5"
      :aria-label="`Context window: ${label}`"
    >
      <svg
        v-if="percent !== null"
        viewBox="0 0 16 16"
        class="size-4 -rotate-90"
        :class="tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : 'text-primary'"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="6" fill="none" stroke-width="2.5" class="stroke-(--ui-border-accented)" />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          :stroke-dasharray="`${(Math.min(100, percent) / 100) * RING} ${RING}`"
        />
      </svg>
      <UIcon v-else name="i-lucide-gauge" class="size-4 text-dimmed" />
      <span
        class="hidden text-xs tabular-nums sm:inline"
        :class="tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : 'text-muted'"
      >{{ label }}</span>
    </UButton>

    <template #content>
      <UsageMeterPanel
        :context="context"
        :cost="cost"
        :provider="provider"
      />
    </template>
  </UPopover>
</template>
