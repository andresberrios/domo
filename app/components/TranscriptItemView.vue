<script setup lang="ts">
import type { TranscriptItem } from '~/utils/agentTranscript'

/**
 * One transcript item, rendered the same way wherever it appears: inline in the
 * transcript, or expanded out of an `ActivityGroup`. There is one renderer so
 * the two can never drift.
 */
const props = defineProps<{
  item: TranscriptItem
  /** Permission requests still waiting for an answer; the rest are history. */
  pendingPermissionIds?: string[]
}>()

const item = computed(() => props.item)

/** Only on a coding agent's page, which is where the voice bar lives. */
const route = useRoute()
const replayable = computed(() => route.path.startsWith('/agents/') && props.item.kind === 'assistant')
const { replay } = useAgentVoiceReplay()
/** A tap on the message shows its replay button; there is no hover on a phone. */
const revealed = ref(false)

const permissionPending = computed(() =>
  props.item.kind === 'permission'
  && (props.pendingPermissionIds ?? []).includes(props.item.permissionId)
)
</script>

<template>
  <template v-if="item.kind === 'user'">
    <div class="space-y-2">
      <div v-if="item.spoken" class="flex items-center gap-1 text-xs text-dimmed">
        <UIcon name="i-lucide-mic" class="size-3" />
        <span>Spoken</span>
      </div>
      <MarkdownView :text="item.text" />
      <div v-if="item.attachments?.length" class="flex flex-wrap gap-1.5">
        <UBadge
          v-for="attachment in item.attachments"
          :key="attachment.name"
          icon="i-lucide-paperclip"
          color="neutral"
          variant="subtle"
          size="sm"
          :label="attachment.name"
        />
      </div>
    </div>
  </template>

  <!--
    The replay button stays out of the way: shown on hover, or once the
    message is tapped (it takes focus), and faint even then.
  -->
  <div
    v-else-if="item.kind === 'assistant'"
    class="group/reply relative"
    @click="revealed = true"
  >
    <MarkdownView :text="item.text" />
    <UButton
      v-if="replayable"
      icon="i-lucide-volume-2"
      color="neutral"
      variant="ghost"
      size="xs"
      aria-label="Read this aloud"
      class="absolute -bottom-6 left-0 text-dimmed transition-opacity group-hover/reply:opacity-70 focus-visible:opacity-100"
      :class="revealed ? 'opacity-70' : 'opacity-0'"
      @click.stop="replay(item.text)"
    />
  </div>

  <UCollapsible v-else-if="item.kind === 'thought'" class="w-full">
    <UButton
      label="Thought"
      icon="i-lucide-brain"
      color="neutral"
      variant="link"
      size="xs"
      trailing-icon="i-lucide-chevron-down"
      class="px-0 text-dimmed"
    />
    <template #content>
      <div class="mt-1 border-s-2 border-accented ps-3 text-sm text-muted">
        <MarkdownView :text="item.text" />
      </div>
    </template>
  </UCollapsible>

  <ToolCallCard
    v-else-if="item.kind === 'tool'"
    :tool="item.tool"
  />

  <PlanCard
    v-else-if="item.kind === 'plan'"
    :entries="item.entries"
  />

  <!-- The actionable card is pinned above the composer; inline is a marker only. -->
  <div
    v-else-if="item.kind === 'permission' && permissionPending"
    class="flex items-center gap-2 text-xs text-warning"
  >
    <UIcon name="i-lucide-shield-question" class="size-3.5 shrink-0" />
    <span>Waiting for permission: {{ item.title }}</span>
  </div>

  <div
    v-else-if="item.kind === 'notice'"
    class="flex items-center gap-2 text-xs"
    :class="item.tone === 'error' ? 'text-error' : 'text-dimmed'"
  >
    <UIcon
      :name="item.tone === 'error' ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
      class="size-3.5 shrink-0"
    />
    <span>{{ item.text }}</span>
  </div>
</template>
