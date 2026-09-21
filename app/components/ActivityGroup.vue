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
 */
const props = defineProps<{ group: ActivityGroup }>()

const open = ref(false)

const label = computed(() => activityLabel(props.group))
const breakdown = computed(() => activityBreakdown(props.group))
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
        <span v-if="breakdown" class="min-w-0 truncate text-xs font-normal text-dimmed">{{ breakdown }}</span>
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
