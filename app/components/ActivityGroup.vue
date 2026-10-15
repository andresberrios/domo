<script setup lang="ts">
import type { ActivityGroup, TranscriptItem } from '~/utils/agentTranscript'

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
 * call starting or finishing changes words and never the row's height. A run
 * of one call is a group too, so that it is the same row from start to end.
 */
const props = defineProps<{ group: ActivityGroup }>()

const open = ref(false)

const label = computed(() => activityLabel(props.group))
const breakdown = computed(() => activityBreakdown(props.group))

const names = useDomoNames()
const alwaysShowTimes = useAlwaysShowTimes()
const { revealed, reveal } = useRevealedRow()

/** One item as a line: what the agent is doing, or did. */
function line(item: TranscriptItem) {
  if (item.kind === 'thought') {
    const last = item.text.trim().split('\n').pop() ?? ''
    return { icon: 'i-lucide-loader-circle', spin: true, text: last ? `Thinking: ${last}` : 'Thinking', detail: null }
  }
  if (item.kind !== 'tool') return null
  const { tool } = item
  // A background `Agent` call is done at launch; its subagent's calls are what still run (as on its card).
  const running = [tool, ...tool.children ?? []].some(call => call.status === 'pending' || call.status === 'in_progress')
  const domo = domoCall(tool)
  const described = domo ? describeDomoCall(domo, names) : null
  const command = tool.rawInput?.command ?? tool.rawInput?.cmd
  return {
    icon: running ? 'i-lucide-loader-circle' : (described?.icon ?? TOOL_KIND_ICONS[tool.kind] ?? TOOL_KIND_ICONS.other!),
    spin: running,
    text: described ? [described.label, described.subject].filter(Boolean).join(' ') : tool.title,
    // Left off on a phone, where the line has room for the title and no more.
    detail: !described && command ? String(command) : null
  }
}

/**
 * In place of the breakdown: the latest item while the run is live, and the
 * call itself for a run of one, where "Bash ×1" would say less than its title.
 */
const current = computed(() => {
  const { items, live } = props.group
  if (live) return line(items[items.length - 1]!)
  return items.length === 1 && items[0]!.kind === 'tool' ? line(items[0]!) : null
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
          <span class="min-w-0 truncate">{{ current.text }}<span v-if="current.detail" class="hidden sm:inline"> · {{ current.detail }}</span></span>
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
      <!--
        Each item's time hangs in the gutter to its left, level with its first
        line: the space under the row's avatar, which is empty. Like a row's
        own time it shows on hover, after a tap, or always, and takes no room.
      -->
      <div class="mt-2 space-y-2 border-s-2 border-accented ps-3">
        <div
          v-for="item in group.items"
          :key="item.id"
          class="group/item relative"
          @pointerup="reveal(item.id, $event)"
        >
          <time
            :datetime="item.at"
            :title="fullTime(item.at)"
            class="pointer-events-none absolute right-full top-0 me-4 flex flex-col items-end justify-center text-[10px] leading-3 text-dimmed tabular-nums transition-opacity"
            :class="[
              item.kind === 'thought' ? 'h-6' : 'h-9',
              alwaysShowTimes || revealed === item.id ? 'opacity-100' : 'opacity-0 group-hover/item:opacity-100'
            ]"
            data-testid="item-time"
          >
            <span>{{ clockParts(item.at).time }}</span>
            <span v-if="clockParts(item.at).period">{{ clockParts(item.at).period }}</span>
          </time>
          <TranscriptItemView :item="item" />
        </div>
      </div>
    </template>
  </UCollapsible>
</template>
