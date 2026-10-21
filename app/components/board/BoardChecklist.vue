<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement, BoardElementContent, BoardItemStatus } from '~~/shared/types/board'

/** Items by status. A done item is acknowledged with one click and then folds away. */
const props = defineProps<{
  element: BoardElement
  content: Extract<BoardElementContent, { kind: 'checklist' }>
  state: BoardState
  readonly?: boolean
}>()

const STATUS: Record<BoardItemStatus, { icon: string, class: string, label: string }> = {
  todo: { icon: 'i-lucide-circle', class: 'text-dimmed', label: 'To do' },
  ongoing: { icon: 'i-lucide-circle-dot', class: 'text-primary', label: 'Ongoing' },
  done: { icon: 'i-lucide-circle-check', class: 'text-success', label: 'Done' },
  blocked: { icon: 'i-lucide-circle-alert', class: 'text-error', label: 'Blocked' }
}

const draft = computed(() => props.state.draftFor(props.element.id))
const acknowledged = computed(() => new Set(props.element.response.acknowledgedItems ?? []))
const marked = computed(() => new Set(draft.value.acknowledgeItems ?? []))

const shown = computed(() => props.content.items.filter(item => !acknowledged.value.has(item.id)))
const hidden = computed(() => props.content.items.length - shown.value.length)
const done = computed(() => props.content.items.filter(item => item.status === 'done').length)
const unacknowledgedDone = computed(() => shown.value.filter(item => item.status === 'done').map(item => item.id))

function toggle(itemId: string) {
  const current = draft.value.acknowledgeItems ?? []
  const next = current.includes(itemId) ? current.filter(id => id !== itemId) : [...current, itemId]
  props.state.updateDraft(props.element.id, { acknowledgeItems: next })
}
function acknowledgeAll() {
  props.state.updateDraft(props.element.id, { acknowledgeItems: unacknowledgedDone.value })
}
const allMarked = computed(() => unacknowledgedDone.value.length > 0 && unacknowledgedDone.value.every(id => marked.value.has(id)))
</script>

<template>
  <div class="mt-2">
    <div class="mb-1.5 flex items-center gap-2">
      <UProgress :model-value="content.items.length ? (done / content.items.length) * 100 : 0" size="xs" class="flex-1" />
      <span class="shrink-0 text-xs text-muted tabular-nums">{{ done }}/{{ content.items.length }}</span>
    </div>
    <ul class="flex flex-col">
      <li
        v-for="item in shown"
        :key="item.id"
        class="group/item flex items-start gap-2 rounded-md py-1"
        :class="marked.has(item.id) ? 'opacity-60' : ''"
      >
        <UTooltip :text="STATUS[item.status].label">
          <UIcon :name="STATUS[item.status].icon" class="mt-0.5 size-4 shrink-0" :class="STATUS[item.status].class" />
        </UTooltip>
        <div class="min-w-0 flex-1 text-sm">
          <p :class="[item.status === 'done' ? 'text-muted' : 'text-default', marked.has(item.id) ? 'line-through' : '']">
            {{ item.text }}
          </p>
          <p v-if="item.note" class="text-xs" :class="item.status === 'blocked' ? 'text-error' : 'text-muted'">
            {{ item.note }}
          </p>
        </div>
        <UButton
          v-if="item.status === 'done' && !readonly"
          :icon="marked.has(item.id) ? 'i-lucide-check-check' : 'i-lucide-check'"
          :color="marked.has(item.id) ? 'primary' : 'neutral'"
          :variant="marked.has(item.id) ? 'soft' : 'ghost'"
          size="xs"
          :aria-label="`Acknowledge ${item.text}`"
          :aria-pressed="marked.has(item.id)"
          @click="toggle(item.id)"
        />
      </li>
    </ul>
    <div class="flex items-center gap-2">
      <UButton
        v-if="!readonly && unacknowledgedDone.length > 1 && !allMarked"
        :label="`Got it, all ${unacknowledgedDone.length} done`"
        icon="i-lucide-check-check"
        color="neutral"
        variant="outline"
        size="xs"
        class="mt-1"
        @click="acknowledgeAll"
      />
      <span v-if="hidden" class="mt-1 text-xs text-dimmed">{{ hidden }} acknowledged</span>
    </div>
  </div>
</template>
