<script setup lang="ts">
import { watchDebounced } from '@vueuse/core'
import type { BoardState } from '~/composables/useBoard'

/**
 * The status board beside the transcript: a resizable panel left of it on a
 * wide screen, a slideover on a narrow one. Looking at it is what clears the
 * dot on the toggle; what changed since the last look stays marked while it
 * is open.
 */
const props = defineProps<{
  state: BoardState
  /** Nothing can be sent: the session cannot run, or has handed off. */
  readonly?: boolean
  /** The agent is mid-turn, so a submit waits for the turn to end. */
  busy?: boolean
}>()

const { open, wide } = useBoardVisibility()

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
  <UDashboardPanel
    v-if="wide && open"
    id="board"
    resizable
    :default-size="32"
    :min-size="22"
    :max-size="55"
    :ui="{ body: 'p-3 sm:p-4 gap-3 sm:gap-3' }"
  >
    <template #header>
      <UDashboardNavbar title="Status board" icon="i-lucide-layout-list" :toggle="false">
        <template #right>
          <UButton icon="i-lucide-panel-left-close" color="neutral" variant="ghost" aria-label="Hide the status board" @click="open = false" />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <BoardView :state="state" :readonly="readonly" :since="since" />
    </template>
    <template #footer>
      <BoardDraftBar v-if="!readonly" :state="state" :busy="busy" />
    </template>
  </UDashboardPanel>

  <USlideover
    v-if="!wide"
    v-model:open="open"
    side="left"
    title="Status board"
    :ui="{ body: 'p-3 sm:p-4', footer: 'p-0 sm:p-0' }"
  >
    <template #body>
      <BoardView :state="state" :readonly="readonly" :since="since" />
    </template>
    <template v-if="!readonly && state.pendingCount.value" #footer>
      <BoardDraftBar :state="state" :busy="busy" class="w-full" />
    </template>
  </USlideover>
</template>
