<script setup lang="ts">
/**
 * Centered empty / not-found / onboarding panel. Reused for first-run,
 * "project not found", "no environments", etc. Default slot holds the
 * call-to-action button(s).
 */
withDefaults(
  defineProps<{
    icon?: string
    title: string
    description?: string
  }>(),
  { icon: 'i-lucide-inbox', description: undefined },
)
</script>

<template>
  <div class="h-full flex items-center justify-center p-8">
    <div class="max-w-md text-center">
      <div
        class="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-elevated"
      >
        <UIcon :name="icon" class="size-6 text-muted" />
      </div>
      <h2 class="text-lg font-semibold">
        {{ title }}
      </h2>
      <p v-if="description" class="mt-1 text-sm text-muted">
        {{ description }}
      </p>
      <div
        v-if="$slots.default"
        class="mt-5 flex flex-wrap items-center justify-center gap-2"
      >
        <slot />
      </div>
    </div>
  </div>
</template>
