<script setup lang="ts">
/**
 * One rename dialog for every renameable thing in the tree. The caller owns the
 * request, because each target has its own endpoint; this only collects a name.
 */
const open = defineModel<boolean>('open', { default: false })
const props = withDefaults(defineProps<{
  title?: string
  description?: string
  label?: string
  initial?: string
  loading?: boolean
}>(), {
  title: 'Rename',
  description: 'Changes the name shown in Domo. Nothing on disk is renamed.',
  label: 'Name',
  initial: '',
  loading: false
})

const emit = defineEmits<{ submit: [name: string] }>()

const draft = ref(props.initial)

watch(open, (isOpen) => {
  if (isOpen) draft.value = props.initial
})

function submit() {
  const value = draft.value.trim()
  if (!value) return
  emit('submit', value)
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description">
    <template #body>
      <UFormField :label="label">
        <UInput v-model="draft" class="w-full" autofocus @keyup.enter="submit" />
      </UFormField>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton label="Rename" :loading="loading" :disabled="!draft.trim()" @click="submit" />
      </div>
    </template>
  </UModal>
</template>
