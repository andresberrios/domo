<script setup lang="ts">
import type { AgentUsage, UsageProviderId } from '~~/shared/types'

/**
 * What a session's usage chip opens onto: the context window, the account's
 * plan limits, and what the session has cost.
 *
 * Its own component rather than a slot inside `UsageMeter` so it can be
 * rendered — and tested — without a popover around it. Every section is hidden
 * when it has nothing to say: a voice conversation has no cost and no plan
 * limits behind it, and drawing the headings anyway would promise data that is
 * never coming.
 */
const props = defineProps<{
  context: { used: number, size: number | null }
  cost?: AgentUsage['cost'] | null
  provider?: UsageProviderId
}>()

const { forProvider, providerState } = useUsageLimits()

const percent = computed(() => percentOf(props.context.used, props.context.size))
const tone = computed(() => usageTone(percent.value))
const limits = computed(() => (props.provider ? forProvider(props.provider) : []))
const provider = computed(() => (props.provider ? providerState(props.provider) : null))
</script>

<template>
  <div class="w-72 space-y-3 p-3">
    <div class="space-y-1">
      <div class="flex items-baseline gap-2">
        <span class="flex-1 text-sm font-medium">Context window</span>
        <span class="text-xs tabular-nums text-muted">
          {{ formatTokens(context.used) }}<template v-if="context.size"> / {{ formatTokens(context.size) }}</template>
          <template v-if="percent !== null"> ({{ formatPercent(percent) }})</template>
        </span>
      </div>
      <UProgress v-if="percent !== null" :model-value="Math.min(100, percent)" :color="tone" size="sm" />
      <p v-else class="text-[11px] text-dimmed">
        No context size is known for this model, so only the token count is shown.
      </p>
    </div>

    <template v-if="provider || limits.length">
      <USeparator />
      <UsageLimitRows :limits="limits" :provider="provider" compact />
    </template>

    <template v-if="cost">
      <USeparator />
      <div class="flex items-baseline gap-2">
        <span class="flex-1 text-sm font-medium">Session cost</span>
        <span class="text-xs tabular-nums text-muted">{{ formatAmount(cost.amount, cost.currency) }}</span>
      </div>
    </template>
  </div>
</template>
