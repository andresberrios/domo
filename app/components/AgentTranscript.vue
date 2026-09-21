<script setup lang="ts">
import type { AgentEvent, AgentSession, PendingPermission } from '~~/shared/types'
import type { CondensedItem } from '~/utils/agentTranscript'

const props = withDefaults(defineProps<{
  session: AgentSession
  events: AgentEvent[]
  permissions: PendingPermission[]
  /** Collapse runs of tool activity into one row. On unless told otherwise. */
  condensed?: boolean
}>(), { condensed: true })

/**
 * Two passes, and only the first one is about the log: `buildTranscript()` says
 * what happened, `condenseTranscript()` decides what to draw.
 */
const built = computed(() => buildTranscript(props.events, props.permissions))

/** A trailing thought is the live tail only while the agent is still working. */
const live = computed(() => props.session.status === 'thinking' || props.session.status === 'starting')

const items = computed<CondensedItem[]>(() =>
  props.condensed ? condenseTranscript(built.value, { live: live.value }) : built.value
)

/**
 * UChatMessages speaks UIMessage: the rich item rides in `metadata` and is
 * rendered by the `#content` slot, while `parts` carries a plain-text version
 * (UChatMessages skips messages with no parts, and the text is what a copy or a
 * screen reader gets).
 */
function plainText(item: CondensedItem): string {
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
    case 'activity':
      return activityLabel(item)
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

const pendingPermissionIds = computed(() =>
  props.permissions.filter(permission => !permission.resolvedAt).map(permission => permission.id)
)

function itemOf(message: any): CondensedItem {
  return message.metadata.item as CondensedItem
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
      <ActivityGroup
        v-if="itemOf(message).kind === 'activity'"
        :group="(itemOf(message) as any)"
      />
      <TranscriptItemView
        v-else
        :item="(itemOf(message) as any)"
        :pending-permission-ids="pendingPermissionIds"
      />
    </template>
  </UChatMessages>
</template>
