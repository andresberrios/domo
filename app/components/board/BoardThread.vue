<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement } from '~~/shared/types/board'

/** The conversation on one element, and the human's next reply to it while it is a draft. */
const props = defineProps<{
  element: BoardElement
  state: BoardState
  readonly?: boolean
  /** The card asked for an empty reply box. */
  replying?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const draftReply = computed(() => props.state.draftFor(props.element.id).reply ?? '')
const focused = ref(false)
const text = ref(draftReply.value)
watch(draftReply, (value) => {
  if (!focused.value) text.value = value
})
function typed(value: string) {
  text.value = value
  props.state.updateDraft(props.element.id, { reply: value }, { typing: true })
}
function remove() {
  text.value = ''
  props.state.updateDraft(props.element.id, { reply: undefined })
  emit('close')
}
function blurred() {
  focused.value = false
  if (!text.value.trim()) emit('close')
}

/** The last few; a long thread is the agent's to summarise into the element. */
const shown = computed(() => props.element.thread.slice(-6))
</script>

<template>
  <div v-if="shown.length || (!readonly && (replying || draftReply))" class="mt-2 flex flex-col gap-1.5">
    <p v-if="element.thread.length > shown.length" class="text-xs text-dimmed">
      {{ element.thread.length - shown.length }} earlier
    </p>
    <div
      v-for="(entry, index) in shown"
      :key="index"
      class="rounded-md px-2.5 py-1.5 text-sm"
      :class="entry.from === 'user' ? 'ms-6 bg-primary/10' : 'me-6 bg-elevated'"
    >
      <p class="text-[11px] text-muted">
        {{ entry.from === 'user' ? 'You' : 'Agent' }} · {{ relativeTime(entry.at) }}
      </p>
      <p class="whitespace-pre-wrap">
        {{ entry.text }}
      </p>
    </div>
    <div v-if="!readonly && (replying || draftReply)" class="flex items-start gap-1">
      <UTextarea
        :model-value="text"
        placeholder="Reply on this…"
        autoresize
        :rows="1"
        :maxrows="10"
        size="sm"
        class="flex-1"
        :autofocus="replying && !draftReply"
        @focus="focused = true"
        @blur="blurred"
        @update:model-value="typed(String($event))"
      />
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" class="mt-0.5" aria-label="Remove the reply" @click="remove" />
    </div>
  </div>
</template>
