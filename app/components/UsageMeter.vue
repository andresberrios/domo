<script setup lang="ts">
import type { AgentUsage, UsageProviderId, VoiceUsage } from '~~/shared/types'

/**
 * A session's context-window chip, with the account's limits behind it.
 *
 * The chip has to survive a mobile header, so it is a percentage and a hairline
 * bar and nothing else; everything that needs words is in `UsageMeterPanel`
 * behind the popover. With no reading at all it renders nothing rather than a
 * zero — a fresh session has not reported yet, and "0%" would be a claim rather
 * than a gap.
 */
const props = defineProps<{
  usage: AgentUsage | VoiceUsage | null
  /** Whose plan limits to show under the context bar. Omitted for a voice session. */
  provider?: UsageProviderId
}>()

const context = computed(() => props.usage?.context ?? null)
const percent = computed(() => (context.value ? percentOf(context.value.used, context.value.size) : null))
const tone = computed(() => usageTone(percent.value))

/** The cost only exists on a coding session, and only once a turn has ended. */
const cost = computed(() => {
  const usage = props.usage as AgentUsage | null
  return usage && 'cost' in usage && usage.cost ? usage.cost : null
})

const label = computed(() => {
  if (!context.value) return ''
  // A model whose window Domo does not know gets a token count and no bar: a
  // percentage needs a denominator, and inventing one would be a lie.
  return percent.value === null ? formatTokens(context.value.used) : formatPercent(percent.value)
})
</script>

<template>
  <UPopover v-if="context" :content="{ align: 'end' }">
    <UButton color="neutral" variant="ghost" size="sm" class="gap-1.5" aria-label="Usage">
      <UIcon name="i-lucide-gauge" class="size-3.5 text-dimmed" />
      <span
        class="text-xs tabular-nums"
        :class="tone === 'error' ? 'text-error' : tone === 'warning' ? 'text-warning' : undefined"
      >{{ label }}</span>
      <span v-if="percent !== null" class="hidden h-1 w-8 overflow-hidden rounded-full bg-elevated sm:block">
        <span
          class="block h-full rounded-full"
          :class="tone === 'error' ? 'bg-error' : tone === 'warning' ? 'bg-warning' : 'bg-primary'"
          :style="{ width: `${Math.min(100, percent)}%` }"
        />
      </span>
    </UButton>

    <template #content>
      <UsageMeterPanel :context="context" :cost="cost" :provider="provider" />
    </template>
  </UPopover>
</template>
