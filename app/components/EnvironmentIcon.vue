<script setup lang="ts">
/**
 * A dev environment, as a glyph. `i-lucide-container` rather than
 * `i-lucide-box`: beside the project's `i-lucide-folder-git-2` the stacked
 * shipping-container outline reads as "a machine of its own", where a plain box
 * reads as another folder.
 */
const props = withDefaults(defineProps<{ status: string, size?: string }>(), {
  size: 'size-4'
})

const meta = computed(() => ENVIRONMENT_STATUS_META[props.status] ?? ENVIRONMENT_STATUS_META.stopped!)
</script>

<template>
  <span class="inline-flex shrink-0 items-center">
    <UIcon name="i-lucide-container" :class="[size, meta.icon]" />
    <slot :label="meta.label">
      <span class="sr-only">{{ meta.label }}</span>
    </slot>
  </span>
</template>
