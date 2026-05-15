<script setup lang="ts">
/**
 * Rendered markdown preview via Comark (the `@comark/nuxt` module
 * auto-registers `<Comark>`). Same renderer the Phase 3 chat surface uses
 * for assistant text, so markdown looks identical in both places.
 */
defineProps<{ content: string }>()
</script>

<template>
  <div class="overflow-auto h-full min-h-0 p-4">
    <Comark :markdown="content" class="prose dark:prose-invert max-w-none" />
  </div>
</template>
