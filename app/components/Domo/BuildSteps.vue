<script setup lang="ts">
import type { BuildStep, StepState } from '~/composables/useBuildProgress'

defineProps<{ steps: BuildStep[] }>()

const ICON: Record<StepState, { name: string; class: string; spin?: boolean }> = {
  pending: { name: 'i-lucide-circle', class: 'text-muted' },
  running: { name: 'i-lucide-loader-circle', class: 'text-primary', spin: true },
  done: { name: 'i-lucide-circle-check', class: 'text-success' },
  skipped: { name: 'i-lucide-circle-minus', class: 'text-muted' },
  warn: { name: 'i-lucide-circle-alert', class: 'text-warning' },
  failed: { name: 'i-lucide-circle-x', class: 'text-error' },
}
</script>

<template>
  <div class="rounded-md bg-elevated/40 text-sm p-3 max-h-72 overflow-auto border border-default space-y-1">
    <div v-if="steps.length === 0" class="text-muted text-xs">
      Waiting for coastd…
    </div>
    <div v-for="s in steps" :key="s.name">
      <div class="flex items-center gap-2">
        <UIcon
          :name="ICON[s.state].name"
          :class="[ICON[s.state].class, ICON[s.state].spin ? 'animate-spin' : '', 'size-4 shrink-0']"
        />
        <span :class="s.state === 'pending' ? 'text-muted' : ''">{{ s.name }}</span>
        <span
          v-if="s.number && s.total"
          class="text-xs text-muted ml-auto tabular-nums"
        >{{ s.number }}/{{ s.total }}</span>
      </div>
      <div
        v-if="s.items.length"
        class="ml-6 mt-0.5 font-mono text-xs text-muted space-y-0.5"
      >
        <div v-for="(it, i) in s.items" :key="i" class="truncate">
          {{ it }}
        </div>
      </div>
    </div>
  </div>
</template>
