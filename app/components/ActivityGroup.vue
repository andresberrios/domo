<script setup lang="ts">
import type { ActivityGroup } from '~/utils/agentTranscript'

/**
 * A collapsed run of tool activity: one row instead of the dozens of cards a
 * working agent produces. Expanding renders the very same items through
 * `TranscriptItemView`, so what is behind the row is not a second rendering of
 * the transcript — it is the transcript.
 *
 * The open state is component-local and the group's id is stable, so a group
 * the user opened stays open while events stream in below it.
 *
 * A live group's last item is what the agent is doing right now. Collapsed,
 * the header says so in place of the breakdown, on the same one line, so a
 * call starting or finishing changes words and never the row's height.
 */
const props = defineProps<{ group: ActivityGroup }>()

const open = ref(false)

const label = computed(() => activityLabel(props.group))
const breakdown = computed(() => activityBreakdown(props.group))

const current = computed(() => {
  if (!props.group.live) return null
  const item = props.group.items[props.group.items.length - 1]!
  if (item.kind === 'thought') {
    const line = item.text.trim().split('\n').pop() ?? ''
    return { icon: 'i-lucide-loader-circle', spin: true, text: line ? `Thinking: ${line}` : 'Thinking' }
  }
  if (item.kind !== 'tool') return null
  const { tool } = item
  const running = tool.status === 'pending' || tool.status === 'in_progress'
  const command = tool.rawInput?.command ?? tool.rawInput?.cmd
  return {
    icon: running ? 'i-lucide-loader-circle' : (TOOL_KIND_ICONS[tool.kind] ?? TOOL_KIND_ICONS.other!),
    spin: running,
    text: command ? `${tool.title} · ${command}` : tool.title
  }
})
</script>

<template>
  <UCollapsible v-model:open="open" class="w-full">
    <UButton
      color="neutral"
      variant="subtle"
      size="sm"
      block
      icon="i-lucide-layers"
      :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
    >
      <span class="flex min-w-0 flex-1 items-center gap-2">
        <span class="shrink-0">{{ label }}</span>
        <span
          v-if="current"
          data-testid="activity-current"
          class="flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted"
        >
          <UIcon :name="current.icon" class="size-3.5 shrink-0" :class="current.spin ? 'animate-spin text-primary' : ''" />
          <span class="min-w-0 truncate">{{ current.text }}</span>
        </span>
        <span v-else-if="breakdown" class="min-w-0 truncate text-xs font-normal text-dimmed">{{ breakdown }}</span>
      </span>
      <UBadge
        v-if="group.failed"
        color="error"
        variant="subtle"
        size="sm"
        :label="`${group.failed} failed`"
      />
    </UButton>

    <template #content>
      <div class="mt-2 space-y-2 border-s-2 border-accented ps-3">
        <TranscriptItemView
          v-for="item in group.items"
          :key="item.id"
          :item="item"
        />
      </div>
    </template>
  </UCollapsible>
</template>
