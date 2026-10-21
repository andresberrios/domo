<script setup lang="ts">
import type { BoardElementContent } from '~~/shared/types/board'

/** Numbers worth a glance; a bar when the agent says what the whole is. */
defineProps<{ content: Extract<BoardElementContent, { kind: 'metrics' }> }>()

const percent = (value: number | string, max?: number) =>
  typeof value === 'number' && max ? Math.min(100, Math.max(0, (value / max) * 100)) : null
</script>

<template>
  <div class="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
    <div v-for="item in content.items" :key="item.id" class="rounded-md bg-elevated/60 px-2.5 py-2">
      <p class="truncate text-xs text-muted">
        {{ item.label }}
      </p>
      <p class="text-base font-semibold text-highlighted tabular-nums">
        {{ item.value }}<span v-if="item.max !== undefined" class="text-xs font-normal text-muted"> / {{ item.max }}</span><span v-if="item.unit" class="ms-0.5 text-xs font-normal text-muted">{{ item.unit }}</span>
      </p>
      <UProgress v-if="percent(item.value, item.max) !== null" :model-value="percent(item.value, item.max)!" size="2xs" class="mt-1" />
    </div>
  </div>
</template>
