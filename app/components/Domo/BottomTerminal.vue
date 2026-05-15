<script setup lang="ts">
defineEmits<{ close: [] }>()
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="flex items-center justify-between border-b border-default px-2 py-1">
      <span class="text-xs text-muted">Terminal — coast exec proxy (Phase 2)</span>
      <UButton size="xs" variant="ghost" icon="i-lucide-chevrons-down" @click="$emit('close')" />
    </div>
    <div class="flex-1 min-h-0 bg-elevated/40 font-mono text-xs p-2 text-muted">
      xterm.js will mount here once we wire `WS /api/terminal` to coastd's `WS /api/v1/exec`.
    </div>
  </div>
</template>
