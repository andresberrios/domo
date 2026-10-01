<script setup lang="ts">
/**
 * A row's chevron, or the empty space one takes, so the icons of every row at
 * one depth line up whether or not the row has anything to open.
 */
defineProps<{
  expanded: boolean
  /** What it opens, for its accessible name. */
  label: string
  /** Nothing to open: keep the space, show nothing. */
  empty?: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <span v-if="empty" class="size-6 shrink-0" aria-hidden="true" />
  <UButton
    v-else
    icon="i-lucide-chevron-right"
    color="neutral"
    variant="link"
    size="xs"
    class="size-6 shrink-0 justify-center p-0 text-dimmed hover:text-default"
    :ui="{ leadingIcon: ['size-3.5 transition-transform', expanded ? 'rotate-90' : ''] }"
    :aria-expanded="expanded"
    :aria-label="expanded ? `Collapse ${label}` : `Expand ${label}`"
    @click="emit('toggle')"
  />
</template>
