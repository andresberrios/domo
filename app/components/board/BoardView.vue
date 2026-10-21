<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement, BoardGroup } from '~~/shared/types/board'
import { needsYou } from '~~/shared/board'

/**
 * The board: its headline, what is not in any group, then one section per
 * workstream; what the human has dealt with folds away underneath. "Needs
 * you" narrows it to what is waiting on them, across every group.
 */
const props = defineProps<{
  state: BoardState
  readonly?: boolean
  /** Elements changed after this are marked as new. */
  since?: string | null
}>()

const board = computed(() => props.state.board.value)
const filter = ref<'all' | 'needs'>('all')
const waiting = computed(() => props.state.visible.value.filter(needsYou))
const shown = computed(() => filter.value === 'needs' ? waiting.value : props.state.visible.value)
watch(() => waiting.value.length, (count) => {
  if (!count) filter.value = 'all'
})

const top = computed(() => shown.value.filter(element => element.group === null))

/** Every group, with its shown elements; a group with nothing shown keeps its header unless filtering. */
const groups = computed(() => {
  const known = board.value?.groups ?? []
  const byTitle = new Map<string, BoardElement[]>()
  for (const element of shown.value) {
    if (element.group === null) continue
    byTitle.set(element.group, [...byTitle.get(element.group) ?? [], element])
  }
  const list: Array<{ group: BoardGroup, elements: BoardElement[] }> = known.map(group => ({ group, elements: byTitle.get(group.title) ?? [] }))
  // An element whose group the board does not list still shows.
  for (const [title, elements] of byTitle) {
    if (!known.some(group => group.title === title)) list.push({ group: { title }, elements })
  }
  return filter.value === 'needs' ? list.filter(entry => entry.elements.length) : list
})

const showCleared = ref(false)
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="board?.headline" class="text-sm font-medium text-highlighted">
      {{ board.headline }}
    </p>

    <div v-if="waiting.length" class="flex items-center gap-1">
      <UButton
        label="All"
        size="xs"
        color="neutral"
        :variant="filter === 'all' ? 'soft' : 'ghost'"
        :aria-pressed="filter === 'all'"
        @click="filter = 'all'"
      />
      <UButton
        size="xs"
        icon="i-lucide-hand"
        :color="filter === 'needs' ? 'primary' : 'neutral'"
        :variant="filter === 'needs' ? 'soft' : 'ghost'"
        :aria-pressed="filter === 'needs'"
        @click="filter = 'needs'"
      >
        Needs you
        <UBadge :label="String(waiting.length)" size="sm" color="primary" variant="subtle" />
      </UButton>
    </div>

    <div v-if="state.isReady.value && !board?.elements.length && !board?.groups.length" class="flex flex-1 flex-col items-center justify-center py-12 text-center">
      <UIcon name="i-lucide-layout-list" class="size-8 text-dimmed" />
      <p class="mt-3 text-sm font-medium">
        Nothing on the board yet
      </p>
      <p class="mt-1 max-w-xs text-sm text-muted">
        The agent keeps it as it works: questions for you, what is done and ongoing, decisions it made.
      </p>
    </div>

    <p v-else-if="board?.elements.length && !state.visible.value.length && !board.groups.length" class="py-6 text-center text-sm text-muted">
      You are all caught up.
    </p>

    <div v-if="top.length" class="flex flex-col gap-2">
      <BoardCard v-for="element in top" :key="element.id" :element="element" :state="state" :readonly="readonly" :since="since" />
    </div>

    <BoardGroupSection
      v-for="entry in groups"
      :key="entry.group.title"
      :group="entry.group"
      :elements="entry.elements"
      :all="board?.elements ?? []"
      :state="state"
      :readonly="readonly"
      :since="since"
      :force-open="filter === 'needs'"
    />

    <div v-if="state.cleared.value.length && filter === 'all'" class="mt-1">
      <UButton
        :label="`${state.cleared.value.length} cleared`"
        :icon="showCleared ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        color="neutral"
        variant="link"
        size="xs"
        class="px-0"
        @click="showCleared = !showCleared"
      />
      <div v-if="showCleared" class="mt-2 flex flex-col gap-2 opacity-70">
        <BoardCard v-for="element in state.cleared.value" :key="element.id" :element="element" :state="state" readonly :since="since" />
      </div>
    </div>
  </div>
</template>
