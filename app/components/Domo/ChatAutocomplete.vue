<script setup lang="ts">
/**
 * Keyboard-navigable popup for the chat prompt's `/` slash-command and
 * `@`-mention menus (one shared list; the parent owns trigger detection).
 * Anchored above the input. Selection state is driven by the parent so it
 * can intercept Arrow/Enter/Tab/Esc at keydown-capture before the
 * textarea's own handlers (see DomoChatInput).
 */
export interface AutocompleteItem {
  key: string
  title: string
  subtitle?: string
  icon?: string
  /** Right-aligned faint tag, e.g. the command source. */
  tag?: string
}

defineProps<{
  items: AutocompleteItem[]
  selectedIndex: number
  header?: string
}>()
const emit = defineEmits<{
  select: [index: number]
  hover: [index: number]
}>()

const listRef = useTemplateRef<HTMLElement>('listRef')
function scrollSelectedIntoView(idx: number) {
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(
      `[data-idx="${idx}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  })
}
defineExpose({ scrollSelectedIntoView })
</script>

<template>
  <div
    class="absolute bottom-full inset-x-0 mb-1 z-50 rounded-lg border border-default bg-default shadow-lg overflow-hidden"
  >
    <p
      v-if="header"
      class="px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted border-b border-default"
    >
      {{ header }}
    </p>
    <ul ref="listRef" class="max-h-64 overflow-y-auto py-1">
      <li
        v-for="(item, idx) in items"
        :key="item.key"
        :data-idx="idx"
        class="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm"
        :class="
          idx === selectedIndex
            ? 'bg-accented'
            : 'hover:bg-elevated'
        "
        @mousedown.prevent="emit('select', idx)"
        @mouseenter="emit('hover', idx)"
      >
        <UIcon
          v-if="item.icon"
          :name="item.icon"
          class="size-4 shrink-0 text-muted"
        />
        <div class="min-w-0 flex-1">
          <div class="truncate font-medium">
            {{ item.title }}
          </div>
          <div v-if="item.subtitle" class="truncate text-xs text-muted">
            {{ item.subtitle }}
          </div>
        </div>
        <span
          v-if="item.tag"
          class="shrink-0 text-[10px] uppercase tracking-wide text-dimmed"
        >
          {{ item.tag }}
        </span>
      </li>
    </ul>
  </div>
</template>
