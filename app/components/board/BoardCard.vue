<script setup lang="ts">
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement } from '~~/shared/types/board'
import { acknowledgeable } from '~~/shared/board'

/**
 * One element: its kind's own view, the actions that fit it, and the thread
 * of replies under it. What the human does here is a draft until submitted,
 * and the card says so.
 */
const props = defineProps<{
  element: BoardElement
  state: BoardState
  readonly?: boolean
  since?: string | null
}>()

const content = computed(() => props.element.content)
const draft = computed(() => props.state.draftFor(props.element.id))
const pending = computed(() => props.state.pending.value.get(props.element.id) ?? 0)

const KIND_ICON: Record<string, string> = {
  question: 'i-lucide-circle-help',
  checklist: 'i-lucide-list-checks',
  decision: 'i-lucide-gavel',
  note: 'i-lucide-sticky-note',
  links: 'i-lucide-link',
  metrics: 'i-lucide-gauge'
}
const TONE: Record<string, { icon: string, class: string }> = {
  info: { icon: 'i-lucide-info', class: 'text-info' },
  success: { icon: 'i-lucide-circle-check', class: 'text-success' },
  warning: { icon: 'i-lucide-triangle-alert', class: 'text-warning' },
  error: { icon: 'i-lucide-octagon-alert', class: 'text-error' }
}
const icon = computed(() => content.value.kind === 'note' ? TONE[content.value.tone]!.icon : KIND_ICON[content.value.kind])
const iconClass = computed(() => {
  if (content.value.kind === 'note') return TONE[content.value.tone]!.class
  if (content.value.kind === 'question' && !props.element.response.answer) return 'text-primary'
  return 'text-muted'
})

const fresh = computed(() => {
  if (!props.since) return null
  if (props.element.createdAt > props.since) return 'New'
  if (props.element.updatedAt > props.since) return 'Updated'
  return null
})

const replying = ref(false)
const canAcknowledge = computed(() => acknowledgeable(props.element) && !props.element.response.acknowledgedAt)

function toggle(key: 'acknowledge' | 'dismiss') {
  props.state.updateDraft(props.element.id, { [key]: !draft.value[key] })
}

const menu = computed(() => [[
  ...draft.value.dismiss
    ? []
    : [{ label: content.value.kind === 'question' ? 'Skip this question' : 'Dismiss', icon: 'i-lucide-x', onSelect: () => toggle('dismiss') }],
  ...pending.value
    ? [{ label: 'Undo my changes', icon: 'i-lucide-undo-2', onSelect: () => props.state.setDraft(props.element.id, {}) }]
    : []
]])
</script>

<template>
  <article
    class="group rounded-lg border bg-default p-3 transition-colors"
    :class="pending ? 'border-primary/60 ring-1 ring-primary/30' : 'border-default'"
    :data-board-element="element.id"
  >
    <header class="flex items-start gap-2">
      <UIcon :name="icon!" class="mt-0.5 size-4 shrink-0" :class="iconClass" />
      <h4 class="min-w-0 flex-1 text-sm font-medium text-highlighted">
        {{ content.title }}
      </h4>
      <UBadge v-if="fresh" :label="fresh" color="primary" variant="subtle" size="sm" />
      <UBadge v-if="draft.dismiss" label="Dismissed" color="neutral" variant="subtle" size="sm" />
      <UDropdownMenu v-if="!readonly && menu[0]!.length" :items="menu">
        <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="-my-1" aria-label="More" />
      </UDropdownMenu>
    </header>

    <div v-if="content.body" class="mt-1.5 ps-6 text-sm text-default">
      <MarkdownView :text="content.body" />
    </div>

    <div class="ps-6">
      <BoardQuestion v-if="content.kind === 'question'" :element="element" :content="content" :state="state" :readonly="readonly" />
      <BoardChecklist v-else-if="content.kind === 'checklist'" :element="element" :content="content" :state="state" :readonly="readonly" />
      <BoardLinks v-else-if="content.kind === 'links'" :content="content" />
      <BoardMetrics v-else-if="content.kind === 'metrics'" :content="content" />
      <p v-else-if="content.kind === 'decision' && content.alternatives?.length" class="mt-1.5 text-xs text-muted">
        Considered: {{ content.alternatives.join(' · ') }}
      </p>

      <BoardThread
        :element="element"
        :state="state"
        :readonly="readonly"
        :replying="replying"
        @close="replying = false"
      />

      <div v-if="!readonly" class="mt-2 flex flex-wrap items-center gap-1.5">
        <UButton
          v-if="canAcknowledge"
          label="Got it"
          :icon="draft.acknowledge ? 'i-lucide-check-check' : 'i-lucide-check'"
          :color="draft.acknowledge ? 'primary' : 'neutral'"
          :variant="draft.acknowledge ? 'soft' : 'outline'"
          size="xs"
          :aria-pressed="!!draft.acknowledge"
          @click="toggle('acknowledge')"
        />
        <UButton
          v-if="!replying && !draft.reply"
          label="Reply"
          icon="i-lucide-reply"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="replying = true"
        />
        <UButton
          v-if="draft.dismiss"
          label="Keep it"
          icon="i-lucide-undo-2"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="toggle('dismiss')"
        />
      </div>
    </div>
  </article>
</template>
