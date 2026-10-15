<script lang="ts">
import type { CondensedItem, TranscriptRowModel } from '~/utils/agentTranscript'

/**
 * `UChatMessage` speaks UIMessage: the rich item rides in `metadata` and is
 * rendered by the `#content` slot, while `parts` carries a plain-text version
 * (a message with no parts renders as the typing indicator, and the text is
 * what a copy or a screen reader gets).
 *
 * The wrappers are cached per item, for the same reason the items themselves
 * are. Keyed on the item, so one carried forward keeps its wrapper and one that
 * changed gets a new one.
 */
const wrappers = new WeakMap<object, any>()

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
    case 'mesh':
      return item.text
    case 'handoff':
      return item.note
    case 'activity':
      return activityLabel(item)
  }
}

function messageFor(item: CondensedItem) {
  const cached = wrappers.get(item)
  if (cached) return cached
  const wrapper = {
    id: item.id,
    role: item.kind === 'user' ? ('user' as const) : ('assistant' as const),
    parts: [{ type: 'text', text: plainText(item) }] as any[],
    metadata: { item }
  }
  wrappers.set(item, wrapper)
  return wrapper
}

const USER_PROPS = { side: 'right', variant: 'soft', avatar: { icon: 'i-lucide-user' } } as const
/** A handoff is a divider across the conversation, not something either side said. */
const DIVIDER_PROPS = { side: 'left', variant: 'naked', avatar: undefined } as const
/** A message that reached this agent from another one, or from Domo. */
const INBOUND_PROPS = { side: 'left', variant: 'naked', avatar: { icon: 'i-lucide-message-square' } } as const
</script>

<script setup lang="ts">
/**
 * One row of a transcript, drawn the same wherever it is drawn: in the list,
 * and offscreen, where the transcript measures a row before the reader gets
 * to it (see `AgentTranscript`). One component, so the height measured is the
 * height the row will have.
 */
const props = defineProps<{
  /** A row of the transcript, or the line naming a day above the first row of that day. */
  item: TranscriptRowModel
  /** Today's `dayKey`, so a day's line can say "Today". */
  today: string
  /** An assistant's face and name, for its side of the conversation. */
  avatar?: { src?: string, alt: string }
  pendingPermissionIds: string[]
}>()

const rowProps = computed(() => {
  const { item } = props
  if (item.kind === 'day') return DIVIDER_PROPS
  if (item.kind === 'user') return USER_PROPS
  if (item.kind === 'handoff') return DIVIDER_PROPS
  if (item.kind === 'mesh' && item.direction === 'in') return INBOUND_PROPS
  return {
    side: 'left',
    variant: 'naked',
    avatar: props.avatar ? { src: props.avatar.src, alt: props.avatar.alt } : { icon: 'i-lucide-sparkles' }
  } as const
})

const alwaysShowTimes = useAlwaysShowTimes()
const { revealed, reveal } = useRevealedRow()
const { replay } = useAgentVoiceReplay()

/** The item, once a day's line has been drawn instead (the template's `v-else`). */
const message = computed(() => props.item as CondensedItem)
</script>

<template>
  <div
    v-if="item.kind === 'day'"
    role="separator"
    class="flex items-center gap-3 text-xs text-dimmed"
    data-testid="day-separator"
  >
    <span class="h-px flex-1 bg-(--ui-border)" />
    <time :datetime="item.at">{{ dayLabel(item.at, today) }}</time>
    <span class="h-px flex-1 bg-(--ui-border)" />
  </div>
  <UChatMessage
    v-else
    v-bind="{ ...rowProps, ...messageFor(message) }"
    @pointerup="reveal(message.id, $event)"
  >
    <template #content>
      <!--
        In the strip Nuxt UI leaves under every message: outside the
        content's box, so nothing here changes a row's height. First, so the
        content's `space-y-4` and `*:last:mb-0` treat the message as the last
        child and leave no margin under it.
      -->
      <TranscriptRowMeta
        :at="message.at"
        :side="rowProps.side"
        :shown="alwaysShowTimes || revealed === message.id"
        :revealed="revealed === message.id"
        :always="alwaysShowTimes"
        :replay="message.kind === 'assistant' ? () => replay((message as { text: string }).text) : undefined"
        @toggle-always="alwaysShowTimes = !alwaysShowTimes"
      />
      <ActivityGroup v-if="message.kind === 'activity'" :group="message" />
      <TranscriptItemView
        v-else
        :item="message"
        :pending-permission-ids="pendingPermissionIds"
      />
    </template>
  </UChatMessage>
</template>
