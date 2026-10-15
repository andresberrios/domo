<script setup lang="ts">
/**
 * A page title that becomes a text field when clicked or tapped. Enter or
 * leaving the field saves; Escape, an empty value or an unchanged one does
 * nothing.
 */
const props = defineProps<{ value: string, label?: string }>()
const emit = defineEmits<{ save: [value: string] }>()

const editing = ref(false)
const draft = ref('')

function edit() {
  draft.value = props.value
  editing.value = true
}

/** Enter and the blur it causes both land here; only the first one counts. */
function finish(save: boolean) {
  if (!editing.value) return
  editing.value = false
  const value = draft.value.trim()
  if (save && value && value !== props.value) emit('save', value)
}
</script>

<template>
  <UInput
    v-if="editing"
    v-model="draft"
    autofocus
    size="sm"
    class="min-w-0 flex-1"
    :aria-label="label ?? 'Title'"
    @keydown.enter.prevent="finish(true)"
    @keydown.esc.prevent="finish(false)"
    @blur="finish(true)"
  />
  <button
    v-else
    type="button"
    class="min-w-0 truncate rounded px-1 -mx-1 text-left hover:bg-elevated/60 focus-visible:outline-2 focus-visible:outline-primary cursor-text"
    :title="`Rename: ${value}`"
    @click="edit"
  >
    {{ value }}
  </button>
</template>
