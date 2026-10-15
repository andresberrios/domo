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
/** Thoughts and handoff notes keep whether they are open by id, as every transcript row does (`useRowOpen`). */
const open = useRowOpen(() => props.item.id)

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

  <!-- Its read-aloud button is in the strip under the row (`TranscriptRowMeta`). -->
  <MarkdownView v-else-if="item.kind === 'assistant'" :text="item.text" />

  <UCollapsible v-else-if="item.kind === 'thought'" v-model:open="open" class="w-full">
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

  <MeshMessageCard
    v-else-if="item.kind === 'mesh'"
    :item="item"
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

  <!-- An assistant's session taking over: a divider, with the note it started from behind it. -->
  <UCollapsible v-else-if="item.kind === 'handoff'" v-model:open="open" class="w-full">
    <div class="flex items-center gap-2 text-xs text-dimmed">
      <span class="h-px flex-1 bg-(--ui-border)" />
      <UButton
        :label="handoffLabel(item.reason)"
        icon="i-lucide-notebook-pen"
        color="neutral"
        variant="link"
        size="xs"
        trailing-icon="i-lucide-chevron-down"
        class="text-dimmed"
      />
      <span class="h-px flex-1 bg-(--ui-border)" />
    </div>
    <template #content>
      <div class="mx-auto mt-2 max-w-2xl rounded-md border border-default bg-elevated/40 px-3 py-2 text-sm text-muted">
        <p class="mb-1 text-xs font-medium text-dimmed">
          The note it started from
        </p>
        <MarkdownView :text="item.note" />
      </div>
    </template>
  </UCollapsible>

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
