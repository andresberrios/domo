<script setup lang="ts">
import type { MeshItem } from '~/utils/agentTranscript'

/**
 * One message between agents, or from an agent to the person, drawn the same
 * at both ends: a single line saying who and what, and the whole message a
 * click away. Collapsed by default because these can run to pages, and the
 * line is one line whatever arrives, so a message never moves what is around
 * it.
 */
const props = defineProps<{ item: MeshItem }>()

const open = ref(false)
const names = useDomoNames()

const peerTitle = computed(() => {
  const { id, title } = props.item.peer
  return title ?? (id ? names.agent(id) ?? id : null) ?? 'an agent'
})

const heading = computed(() => {
  const { direction, via } = props.item
  if (via === 'notify') return 'To you'
  if (via === 'domo') return 'From Domo'
  if (via === 'update') return peerTitle.value
  if (via === 'spawn') return direction === 'out' ? `Started ${peerTitle.value}` : `Task from ${peerTitle.value}`
  return direction === 'out' ? `To ${peerTitle.value}` : `From ${peerTitle.value}`
})

const icon = computed(() => {
  switch (props.item.via) {
    case 'spawn': return 'i-lucide-bot'
    case 'notify': return 'i-lucide-bell-ring'
    case 'update': return 'i-lucide-bell'
    case 'domo': return 'i-lucide-info'
    default: return props.item.direction === 'out' ? 'i-lucide-send' : 'i-lucide-message-square'
  }
})

const preview = computed(() => props.item.text.replace(/\s+/g, ' ').trim())

const status = computed(() => props.item.tool?.status ?? null)
const running = computed(() => status.value === 'pending' || status.value === 'in_progress')

const OUTCOMES: Record<string, string> = {
  prompted: 'Delivered',
  steered: 'Delivered into its running turn',
  queued: 'Queued until its turn ends'
}

/** How the sending went, in words, once it has. */
const outcome = computed(() => {
  const tool = props.item.tool
  if (!tool || running.value) return null
  const result = domoCall(tool)?.result
  if (status.value === 'failed') return typeof result === 'string' ? result : 'Failed'
  if (result && typeof result === 'object' && typeof result.outcome === 'string') return OUTCOMES[result.outcome] ?? result.outcome
  return null
})
</script>

<template>
  <div class="rounded-lg border border-default bg-elevated/30" data-testid="mesh-message">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-start hover:bg-elevated/60"
      :aria-expanded="open"
      @click="open = !open"
    >
      <UIcon :name="icon" class="size-4 shrink-0 text-primary" />
      <span class="min-w-0 flex-1 truncate text-sm">
        <span class="font-medium">{{ heading }}</span>
        <span v-if="preview" class="ms-1.5 text-muted">{{ preview }}</span>
      </span>
      <UBadge
        v-if="running || status === 'failed'"
        :color="running ? 'primary' : 'error'"
        variant="subtle"
        size="sm"
        :label="running ? 'Sending' : 'Failed'"
        :icon="running ? 'i-lucide-loader-circle' : undefined"
        :ui="{ leadingIcon: running ? 'animate-spin' : '' }"
      />
      <UIcon
        name="i-lucide-chevron-down"
        class="size-4 shrink-0 text-dimmed transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <div v-if="open" class="space-y-2 border-t border-default px-3 py-3">
      <MarkdownView v-if="item.text" :text="item.text" />
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span v-if="outcome">{{ outcome }}</span>
        <NuxtLink
          v-if="item.peer.id"
          :to="`/agents/${item.peer.id}`"
          class="inline-flex items-center gap-1 text-primary hover:underline"
        >
          Open {{ peerTitle }}
          <UIcon name="i-lucide-arrow-up-right" class="size-3" />
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
