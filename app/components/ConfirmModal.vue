<script setup lang="ts">
/**
 * An action worth spelling out before it happens, usually a destructive one.
 *
 * `window.confirm` used to do this job on the projects page, which says
 * nothing about what is about to be deleted and cannot be styled or tested.
 *
 * `confirmColor` defaults to `error` because most of these are deletions, but
 * not all of them are: reviving a retired session is worth confirming — it is
 * where the "Domo's transcript survives, the agent's own memory may not"
 * caveat is read — and painting that button red would be a lie about it.
 */
const open = defineModel<boolean>('open', { default: false })
withDefaults(defineProps<{
  title: string
  description: string
  confirmLabel?: string
  confirmColor?: 'error' | 'primary' | 'neutral'
  loading?: boolean
}>(), {
  confirmLabel: 'Delete',
  confirmColor: 'error',
  loading: false
})

const emit = defineEmits<{ confirm: [] }>()
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton :label="confirmLabel" :color="confirmColor" :loading="loading" @click="emit('confirm')" />
      </div>
    </template>
  </UModal>
</template>
