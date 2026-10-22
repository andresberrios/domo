<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement, BoardGroup } from '~~/shared/types/board'
import { effectiveGroupDraft, groupDraftKey, needsYou } from '~~/shared/board'

/**
 * The board: its headline, what is not in any group, then one section per
 * workstream; what the human has dealt with, elements and whole groups, folds
 * away underneath. "Needs you" narrows it to what is waiting on them, across
 * every group.
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
  const list: Array<{ group: BoardGroup, elements: BoardElement[] }> = known
    .filter(group => !props.state.goneGroups.value.has(group.title))
    .map(group => ({ group, elements: byTitle.get(group.title) ?? [] }))
  // An element whose group the board does not list still shows.
  for (const [title, elements] of byTitle) {
    if (!known.some(group => group.title === title)) list.push({ group: { title }, elements })
  }
  return filter.value === 'needs' ? list.filter(entry => entry.elements.length) : list
})

/** The groups the human has cleared or dismissed, each with everything in it. */
const clearedGroups = computed(() => (board.value?.groups ?? [])
  .filter(group => props.state.goneGroups.value.has(group.title))
  .map(group => ({ group, elements: (board.value?.elements ?? []).filter(element => element.group === group.title) })))
const clearedCount = computed(() => clearedGroups.value.length + props.state.cleared.value.length)
const showCleared = ref(false)

/** Done groups not yet cleared, nor about to be: "Clear all done" drafts a clear on each. */
const doneToClear = computed(() => groups.value
  .map(entry => entry.group)
  .filter(group => group.status === 'done'
    && !Object.keys(effectiveGroupDraft(group, board.value?.groupResponses[group.title], props.state.draftFor(groupDraftKey(group.title)))).length))
function clearAllDone() {
  for (const group of doneToClear.value) props.state.setDraft(groupDraftKey(group.title), { acknowledge: true })
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="board?.headline" class="text-sm font-medium text-highlighted">
      {{ board.headline }}
    </p>

    <div v-if="waiting.length || (!readonly && doneToClear.length > 1)" class="flex items-center gap-1">
      <template v-if="waiting.length">
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
      </template>
      <UButton
        v-if="!readonly && doneToClear.length > 1 && filter === 'all'"
        :label="`Clear ${doneToClear.length} done`"
        icon="i-lucide-check-check"
        color="neutral"
        variant="ghost"
        size="xs"
        class="ms-auto"
        @click="clearAllDone"
      />
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

    <p v-else-if="clearedCount && !state.visible.value.length && !groups.length" class="py-6 text-center text-sm text-muted">
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

    <div v-if="clearedCount && filter === 'all'" class="mt-1">
      <UButton
        :label="`${clearedCount} cleared`"
        :icon="showCleared ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
        color="neutral"
        variant="link"
        size="xs"
        class="px-0"
        @click="showCleared = !showCleared"
      />
      <div v-if="showCleared" class="mt-2 flex flex-col gap-2 opacity-70">
        <BoardCard v-for="element in state.cleared.value" :key="element.id" :element="element" :state="state" readonly :since="since" />
        <BoardGroupSection
          v-for="entry in clearedGroups"
          :key="entry.group.title"
          :group="entry.group"
          :elements="entry.elements"
          :all="board?.elements ?? []"
          :state="state"
          :since="since"
          readonly
          cleared
        />
      </div>
    </div>
  </div>
</template>
