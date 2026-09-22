<script setup lang="ts">
/**
 * A destructive action, with the cascade spelled out.
 *
 * `window.confirm` used to do this job on the projects page, which says
 * nothing about what is about to be deleted and cannot be styled or tested.
 */
const open = defineModel<boolean>('open', { default: false })
withDefaults(defineProps<{
  title: string
  description: string
  confirmLabel?: string
  loading?: boolean
}>(), {
  confirmLabel: 'Delete',
  loading: false
})

const emit = defineEmits<{ confirm: [] }>()
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton :label="confirmLabel" color="error" :loading="loading" @click="emit('confirm')" />
      </div>
    </template>
  </UModal>
</template>
