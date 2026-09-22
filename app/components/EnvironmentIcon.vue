<script setup lang="ts">
/**
 * A dev environment, as a glyph. `i-lucide-monitor` rather than
 * `i-lucide-container`: an environment is a sandboxed machine a session
 * runs on, and a monitor reads as "a computer" at a glance — a shipping
 * container reads as infrastructure, which is the implementation, not what
 * the user is looking at.
 */
const props = withDefaults(defineProps<{ status: string, size?: string }>(), {
  size: 'size-4'
})

const meta = computed(() => ENVIRONMENT_STATUS_META[props.status] ?? ENVIRONMENT_STATUS_META.stopped!)
</script>

<template>
  <span class="inline-flex shrink-0 items-center">
    <UIcon name="i-lucide-monitor" :class="[size, meta.icon]" />
    <slot :label="meta.label">
      <span class="sr-only">{{ meta.label }}</span>
    </slot>
  </span>
</template>
