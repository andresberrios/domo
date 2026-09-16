<script setup lang="ts">
import type { AgentEvent, AgentSession, PendingPermission } from '~~/shared/types'
import type { TranscriptItem } from '~/utils/agentTranscript'

const props = defineProps<{
  session: AgentSession
  events: AgentEvent[]
  permissions: PendingPermission[]
}>()

const items = computed(() => buildTranscript(props.events, props.permissions))

/**
 * UChatMessages speaks UIMessage: the rich item rides in `metadata` and is
 * rendered by the `#content` slot, while `parts` carries a plain-text version
 * (UChatMessages skips messages with no parts, and the text is what a copy or a
 * screen reader gets).
 */
function plainText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'thought':
      return item.text
    case 'tool':
      return item.tool.title
    case 'plan':
      return item.entries.map(entry => `${entry.status}: ${entry.content}`).join('\n')
    case 'permission':
      return item.title
    case 'notice':
      return item.text
  }
}

const messages = computed(() =>
  items.value.map(item => ({
    id: item.id,
    role: item.kind === 'user' ? ('user' as const) : ('assistant' as const),
    parts: [{ type: 'text', text: plainText(item) }] as any[],
    metadata: { item }
  }))
)

const status = computed(() => {
  if (props.session.status === 'thinking' || props.session.status === 'starting') return 'streaming' as const
  return 'ready' as const
})

const pendingById = computed(() => {
  const map = new Map<string, PendingPermission>()
  for (const permission of props.permissions) map.set(permission.id, permission)
  return map
})

function itemOf(message: any): TranscriptItem {
  return message.metadata.item as TranscriptItem
}
</script>

<template>
  <UChatMessages
    :messages="messages as any"
    :status="status"
    should-auto-scroll
    :user="{ side: 'right', variant: 'soft', avatar: { icon: 'i-lucide-user' } }"
    :assistant="{ side: 'left', variant: 'naked', avatar: { icon: 'i-lucide-sparkles' } }"
    :ui="{ root: 'w-full max-w-3xl mx-auto gap-4 py-4' }"
  >
    <template #content="message">
      <template v-if="itemOf(message).kind === 'user'">
        <div class="space-y-2">
          <MarkdownView :text="(itemOf(message) as any).text" />
          <div v-if="(itemOf(message) as any).attachments?.length" class="flex flex-wrap gap-1.5">
            <UBadge
              v-for="attachment in (itemOf(message) as any).attachments"
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

      <MarkdownView
        v-else-if="itemOf(message).kind === 'assistant'"
        :text="(itemOf(message) as any).text"
      />

      <UCollapsible v-else-if="itemOf(message).kind === 'thought'" class="w-full">
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
            <MarkdownView :text="(itemOf(message) as any).text" />
          </div>
        </template>
      </UCollapsible>

      <ToolCallCard
        v-else-if="itemOf(message).kind === 'tool'"
        :tool="(itemOf(message) as any).tool"
      />

      <PlanCard
        v-else-if="itemOf(message).kind === 'plan'"
        :entries="(itemOf(message) as any).entries"
      />

      <!-- The actionable card is pinned above the composer; inline is a marker only. -->
      <div
        v-else-if="itemOf(message).kind === 'permission' && pendingById.get((itemOf(message) as any).permissionId)"
        class="flex items-center gap-2 text-xs text-warning"
      >
        <UIcon name="i-lucide-shield-question" class="size-3.5 shrink-0" />
        <span>Waiting for permission: {{ (itemOf(message) as any).title }}</span>
      </div>

      <div
        v-else-if="itemOf(message).kind === 'notice'"
        class="flex items-center gap-2 text-xs"
        :class="(itemOf(message) as any).tone === 'error' ? 'text-error' : 'text-dimmed'"
      >
        <UIcon
          :name="(itemOf(message) as any).tone === 'error' ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
          class="size-3.5 shrink-0"
        />
        <span>{{ (itemOf(message) as any).text }}</span>
      </div>
    </template>
  </UChatMessages>
</template>
