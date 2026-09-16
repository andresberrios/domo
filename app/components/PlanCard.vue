<script setup lang="ts">
const props = defineProps<{ entries: Array<{ content: string, status: string, priority: string }> }>()

const done = computed(() => props.entries.filter(entry => entry.status === 'completed').length)

const ICONS: Record<string, string> = {
  completed: 'i-lucide-circle-check',
  in_progress: 'i-lucide-loader-circle',
  pending: 'i-lucide-circle-dashed'
}
</script>

<template>
  <div class="rounded-lg border border-default bg-elevated/30 p-3">
    <div class="mb-2 flex items-center gap-2">
      <UIcon name="i-lucide-list-checks" class="size-4 text-muted" />
      <span class="text-sm font-medium">Plan</span>
      <span class="text-xs text-muted">{{ done }}/{{ entries.length }}</span>
    </div>
    <ul class="space-y-1.5">
      <li
        v-for="(entry, index) in entries"
        :key="index"
        class="flex items-start gap-2 text-sm"
        :class="entry.status === 'completed' ? 'text-muted line-through' : ''"
      >
        <UIcon
          :name="ICONS[entry.status] ?? ICONS.pending!"
          class="mt-0.5 size-4 shrink-0"
          :class="{
            'text-success': entry.status === 'completed',
            'text-primary animate-spin': entry.status === 'in_progress',
            'text-dimmed': entry.status === 'pending'
          }"
        />
        <span class="min-w-0 flex-1">{{ entry.content }}</span>
      </li>
    </ul>
  </div>
</template>
