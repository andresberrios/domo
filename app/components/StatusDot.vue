<script setup lang="ts">
const props = defineProps<{ status: string }>()
const meta = computed(() => AGENT_STATUS_META[props.status] ?? AGENT_STATUS_META.idle!)
</script>

<template>
  <span class="inline-flex items-center gap-1.5">
    <span class="size-2 shrink-0 rounded-full" :class="meta.dot" />
    <slot :label="meta.label">
      <span class="text-xs text-muted">{{ meta.label }}</span>
    </slot>
  </span>
</template>
