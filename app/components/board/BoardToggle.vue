<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'

/** Opens the status board; a dot while the agent has changed it since you last looked. */
const props = defineProps<{ state: BoardState }>()
const { open } = useBoardVisibility()

const questions = computed(() => props.state.visible.value.filter(element =>
  element.content.kind === 'question' && !element.response.answer).length)
const label = computed(() => open.value ? 'Hide the status board' : 'Show the status board')
</script>

<template>
  <UTooltip :text="label">
    <UChip :show="state.unseen.value && !open" color="primary" size="sm" inset>
      <UButton
        icon="i-lucide-layout-list"
        color="neutral"
        :variant="open ? 'soft' : 'ghost'"
        :label="questions ? String(questions) : undefined"
        :aria-label="label"
        :aria-pressed="open"
        @click="open = !open"
      />
    </UChip>
  </UTooltip>
</template>
