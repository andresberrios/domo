<script setup lang="ts">
const props = defineProps<{ path: string, oldText?: string | null, newText?: string | null }>()

interface Line { type: 'add' | 'del' | 'same', text: string }

const SENTINEL = '__domo_no_match__'

/** Line-level diff: good enough to eyeball an edit, cheap to render. */
const lines = computed<Line[]>(() => {
  const before = (props.oldText ?? '').split('\n')
  const after = (props.newText ?? '').split('\n')
  const out: Line[] = []
  let i = 0
  let j = 0

  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      out.push({ type: 'same', text: before[i]! })
      i++
      j++
      continue
    }
    const nextInAfter = i < before.length ? after.indexOf(before[i] ?? SENTINEL, j) : -1
    const nextInBefore = j < after.length ? before.indexOf(after[j] ?? SENTINEL, i) : -1

    if (i < before.length && (nextInAfter === -1 || (nextInBefore !== -1 && nextInBefore < nextInAfter))) {
      out.push({ type: 'del', text: before[i]! })
      i++
    } else if (j < after.length) {
      out.push({ type: 'add', text: after[j]! })
      j++
    } else {
      out.push({ type: 'del', text: before[i]! })
      i++
    }
  }
  return out
})

const stats = computed(() => ({
  added: lines.value.filter(line => line.type === 'add').length,
  removed: lines.value.filter(line => line.type === 'del').length
}))
</script>

<template>
  <div class="overflow-hidden rounded-lg border border-default">
    <div class="flex items-center justify-between gap-2 border-b border-default bg-elevated/50 px-3 py-1.5">
      <span class="truncate font-mono text-xs text-muted">{{ path }}</span>
      <span class="shrink-0 font-mono text-[11px]">
        <span class="text-success">+{{ stats.added }}</span>
        <span class="ms-2 text-error">-{{ stats.removed }}</span>
      </span>
    </div>
    <div class="max-h-80 overflow-auto bg-default font-mono text-xs leading-5">
      <div
        v-for="(line, index) in lines"
        :key="index"
        class="flex gap-2 px-3 py-px"
        :class="{
          'bg-success/10 text-success': line.type === 'add',
          'bg-error/10 text-error': line.type === 'del',
          'text-muted': line.type === 'same'
        }"
      >
        <span class="w-3 shrink-0 select-none opacity-60">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
        <span class="whitespace-pre-wrap break-all">{{ line.text }}</span>
      </div>
    </div>
  </div>
</template>
