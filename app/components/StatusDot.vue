<script setup lang="ts">
const props = defineProps<{ status: string }>()
const meta = computed(() => AGENT_STATUS_META[props.status] ?? AGENT_STATUS_META.idle!)
</script>

<template>
  <span class="inline-flex items-center gap-1.5">
    <span class="size-2 shrink-0 rounded-full transition-colors duration-(--motion-base)" :class="meta.dot" />
    <slot :label="meta.label">
      <!-- A new status fades in over the old one (`swap`), so "Working" to "Idle" reads as a change, not a flicker. -->
      <Transition name="swap">
        <span :key="meta.label" class="text-xs text-muted">{{ meta.label }}</span>
      </Transition>
    </slot>
  </span>
</template>
