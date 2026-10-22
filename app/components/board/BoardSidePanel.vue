<script setup lang="ts">
import { watchDebounced } from '@vueuse/core'
import type { BoardState } from '~/composables/useBoard'

/**
 * The status board beside the transcript: a resizable right-hand sidebar on a
 * wide screen, a slideover from the right on a narrow one. Looking at it is
 * what clears the dot on the toggle; what changed since the last look stays
 * marked while it is open.
 */
const props = defineProps<{
  state: BoardState
  /** Nothing can be sent: the session cannot run, or has handed off. */
  readonly?: boolean
  /** The agent is mid-turn, so a submit waits for the turn to end. */
  busy?: boolean
}>()

const { open, wide } = useBoardVisibility()

/**
 * The sidebar's narrow-screen menu. Every dashboard sidebar answers the
 * navbar's menu button, so a request to open is ignored here: only the board
 * toggle opens it. Closing (dismissed, or a new page) is taken.
 */
const menuOpen = computed({
  get: () => !wide.value && open.value,
  set: (value: boolean) => {
    if (!value && !wide.value) open.value = false
  }
})
// Any new page starts with it closed: autoClose covers a new route on the same page.
onMounted(() => {
  if (!wide.value) open.value = false
})

/** When the human last looked, as it was when they opened the board this time. */
const since = ref<string | null>(null)
watch(open, (value) => {
  if (value) since.value = props.state.board.value?.seenAt ?? null
}, { immediate: true })

watchDebounced(
  () => [open.value, props.state.unseen.value] as const,
  ([visible, unseen]) => {
    if (visible && unseen) void props.state.markSeen()
  },
  { debounce: 1500, immediate: true }
)
</script>

<template>
  <UDashboardSidebar
    v-if="!wide || open"
    id="board"
    v-model:open="menuOpen"
    side="right"
    resizable
    :toggle="false"
    :default-size="32"
    :min-size="22"
    :max-size="55"
    :menu="{ side: 'right', title: 'Status board', description: 'What the agent is working on and what it needs from you' }"
    :ui="{
      header: 'border-b border-default gap-2',
      body: 'p-3 sm:p-4 gap-3 sm:gap-3',
      footer: 'p-0 sm:p-0'
    }"
  >
    <template #header>
      <UIcon name="i-lucide-layout-list" class="size-5 shrink-0" />
      <h2 class="flex-1 truncate font-semibold text-highlighted">
        Status board
      </h2>
      <UButton icon="i-lucide-panel-right-close" color="neutral" variant="ghost" aria-label="Hide the status board" @click="open = false" />
    </template>

    <BoardView :state="state" :readonly="readonly" :since="since" />

    <template v-if="!readonly && (wide || state.pendingCount.value)" #footer>
      <BoardDraftBar :state="state" :busy="busy" class="w-full" />
    </template>
  </UDashboardSidebar>
</template>
