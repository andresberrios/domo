<script setup lang="ts">
/**
 * An agent, as a glyph: the same robot the agent page is headed with, coloured
 * and animated by status off `AGENT_STATUS_META` exactly as `StatusDot` colours
 * its dot. The label stays in the accessibility tree — colour alone is not a
 * status.
 */
const props = withDefaults(defineProps<{ status: string, size?: string }>(), {
  size: 'size-4'
})

const meta = computed(() => AGENT_STATUS_META[props.status] ?? AGENT_STATUS_META.idle!)
</script>

<template>
  <span class="inline-flex shrink-0 items-center">
    <UIcon name="i-lucide-bot" :class="[size, meta.icon]" />
    <slot :label="meta.label">
      <span class="sr-only">{{ meta.label }}</span>
    </slot>
  </span>
</template>
