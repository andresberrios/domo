<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement, BoardElementContent } from '~~/shared/types/board'

/** Suggested answers, one click each, and the human's own words when the agent allows them. */
const props = defineProps<{
  element: BoardElement
  content: Extract<BoardElementContent, { kind: 'question' }>
  state: BoardState
  readonly?: boolean
}>()

const draft = computed(() => props.state.draftFor(props.element.id))
const answered = computed(() => props.element.response.answer ?? null)
/** What the buttons show: the draft's choice while there is one, else the answer already sent. */
const chosen = computed(() => new Set(draft.value.answer?.options ?? (draft.value.answer ? [] : answered.value?.options ?? [])))
const drafting = computed(() => !!draft.value.answer)

function pick(optionId: string) {
  const current = draft.value.answer?.options ?? []
  let options: string[]
  if (props.content.multiple) {
    options = current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId]
  } else {
    options = current.includes(optionId) ? [] : [optionId]
  }
  props.state.updateDraft(props.element.id, { answer: { options, text: draft.value.answer?.text } })
}

const writing = ref(false)
const text = ref(draft.value.answer?.text ?? '')
watch(() => draft.value.answer?.text, (value) => {
  if (!writing.value) text.value = value ?? ''
})
function typed(value: string) {
  text.value = value
  props.state.updateDraft(props.element.id, { answer: { options: draft.value.answer?.options ?? [], text: value } }, { typing: true })
}
const showText = computed(() => props.content.allowCustom && !props.readonly && (writing.value || !!text.value))
</script>

<template>
  <div class="mt-2 flex flex-col gap-2">
    <div v-if="content.options.length" class="flex flex-wrap gap-1.5">
      <UTooltip v-for="option in content.options" :key="option.id" :text="option.description" :disabled="!option.description">
        <UButton
          :label="option.label"
          :icon="chosen.has(option.id) ? (content.multiple ? 'i-lucide-square-check' : 'i-lucide-circle-check') : undefined"
          :color="chosen.has(option.id) ? 'primary' : 'neutral'"
          :variant="chosen.has(option.id) ? (drafting ? 'solid' : 'soft') : 'outline'"
          size="sm"
          :disabled="readonly"
          :aria-pressed="chosen.has(option.id)"
          @click="pick(option.id)"
        />
      </UTooltip>
    </div>
    <p v-if="content.multiple && !readonly" class="-mt-1 text-xs text-dimmed">
      Pick any that apply.
    </p>

    <UTextarea
      v-if="showText"
      :model-value="text"
      placeholder="Your own answer"
      autoresize
      :rows="1"
      :maxrows="8"
      size="sm"
      class="w-full"
      autofocus
      @focus="writing = true"
      @blur="writing = false"
      @update:model-value="typed(String($event))"
    />
    <UButton
      v-else-if="content.allowCustom && !readonly"
      label="Answer in your own words"
      icon="i-lucide-pencil-line"
      color="neutral"
      variant="link"
      size="xs"
      class="self-start px-0"
      @click="writing = true"
    />

    <p v-if="answered && !drafting" class="text-xs text-muted">
      <UIcon name="i-lucide-check" class="me-1 inline size-3 align-[-2px] text-success" />
      You answered {{ relativeTime(answered.at) }}<template v-if="answered.text">: “{{ answered.text }}”</template>
    </p>
  </div>
</template>
