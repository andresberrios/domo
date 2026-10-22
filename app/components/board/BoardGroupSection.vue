<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement, BoardGroup, BoardGroupStatus } from '~~/shared/types/board'
import { attention, groupContents, groupDraftKey, isFolded } from '~~/shared/board'

/**
 * One workstream: a header that says where it stands and where the human is
 * needed, the agents and branches doing it, and its elements, folded as the
 * human left it (a done group starts folded). Folded, it says what it holds,
 * so an empty group never reads as one whose contents went missing. A done
 * group is cleared with one click, any group dismissed; like everything on
 * the board, that is a draft until submitted.
 */
const props = defineProps<{
  group: BoardGroup
  /** Its elements as shown. */
  elements: BoardElement[]
  /** Every element on the board, for the counts. */
  all: BoardElement[]
  state: BoardState
  readonly?: boolean
  since?: string | null
  /** The "Needs you" view shows every group it lists open. */
  forceOpen?: boolean
  /** Shown under "Cleared": the human has dealt with it. */
  cleared?: boolean
}>()

const STATUS: Record<BoardGroupStatus, { label: string, color: 'primary' | 'warning' | 'error' | 'success' | 'neutral' }> = {
  active: { label: 'Active', color: 'primary' },
  waiting: { label: 'Waiting on you', color: 'warning' },
  blocked: { label: 'Blocked', color: 'error' },
  done: { label: 'Done', color: 'success' }
}

const own = computed(() => props.all.filter(element => element.group === props.group.title))
const expandable = computed(() => props.elements.length > 0)

const folds = computed(() => props.state.board.value?.folds ?? {})
/** Folded here at once; the row catches up when it comes back. */
const local = ref<boolean | null>(null)
watch(() => folds.value[props.group.title], () => { local.value = null })
const folded = computed(() => {
  if (props.forceOpen) return false
  if (props.cleared) return local.value ?? true
  return local.value ?? isFolded(props.group, folds.value)
})
function toggle() {
  if (!expandable.value || props.forceOpen) return
  local.value = !folded.value
  // A cleared group's fold is only for this look at it.
  if (!props.cleared) void props.state.setFolded(props.group.title, local.value)
}

const counts = computed(() => attention(own.value.filter(element => !element.response.dismissedAt)))
const contents = computed(() => groupContents(own.value))
/** What it holds, said whenever its elements are out of sight: folded, or all cleared. */
const showContents = computed(() => own.value.length > 0 && (folded.value || !expandable.value))
const updatedAt = computed(() => props.group.updatedAt
  ?? own.value.reduce<string | null>((latest, element) => !latest || element.updatedAt > latest ? element.updatedAt : latest, null))

const key = computed(() => groupDraftKey(props.group.title))
const draft = computed(() => props.state.draftFor(key.value))
const pending = computed(() => (props.state.pending.value.get(key.value) ?? 0) > 0)
const response = computed(() => props.state.board.value?.groupResponses[props.group.title])
const acting = computed(() => !props.readonly && !props.cleared)
const canClear = computed(() => acting.value && props.group.status === 'done' && !draft.value.dismiss)

function setDraft(change: 'acknowledge' | 'dismiss' | null) {
  props.state.setDraft(key.value, change ? { [change]: true } : {})
}

const menu = computed(() => [[
  ...draft.value.dismiss
    ? []
    : [{ label: 'Dismiss group', icon: 'i-lucide-x', onSelect: () => setDraft('dismiss') }],
  ...pending.value
    ? [{ label: 'Undo', icon: 'i-lucide-undo-2', onSelect: () => setDraft(null) }]
    : []
]])

const { all: sessions } = useAgentSessions()
const { all: assistants } = useAssistants()
const { all: environments } = useDevEnvironments()
const { copy } = useClipboard()

function linkOf(link: NonNullable<BoardGroup['links']>[number]) {
  switch (link.kind) {
    case 'agent': {
      if (link.target.startsWith('as_')) {
        const assistant = assistants.value.find(item => item.id === link.target)
        return { icon: 'i-lucide-bot', label: link.label ?? assistant?.name ?? link.target, to: `/assistants/${link.target}` }
      }
      const session = sessions.value.find(item => item.id === link.target)
      return { icon: 'i-lucide-bot', label: session?.title ?? link.label ?? link.target, to: `/agents/${link.target}`, status: session?.status }
    }
    case 'environment': {
      const environment = environments.value.find(item => item.id === link.target)
      return { icon: 'i-lucide-monitor', label: link.label ?? environment?.name ?? link.target, to: `/environments/${link.target}` }
    }
    case 'branch':
      return { icon: 'i-lucide-git-branch', label: link.label ?? link.target, copy: link.target }
    default:
      return { icon: 'i-lucide-external-link', label: link.label ?? link.target, href: link.target }
  }
}
const links = computed(() => (props.group.links ?? []).map(linkOf))
</script>

<template>
  <section class="flex flex-col gap-2" :data-board-group="group.title">
    <div class="-mx-1 rounded-md px-1 pt-1" :class="pending ? 'ring-1 ring-primary/40' : ''">
      <div class="flex items-start gap-1.5">
        <UButton
          v-if="expandable"
          :icon="folded ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
          color="neutral"
          variant="ghost"
          size="xs"
          class="-ms-1"
          :aria-expanded="!folded"
          :aria-label="folded ? `Show ${group.title}` : `Fold ${group.title}`"
          :disabled="forceOpen"
          @click="toggle"
        />
        <span v-else class="-ms-1 flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
          <span class="size-1.5 rounded-full bg-accented" />
        </span>
        <h3 class="min-w-0 flex-1 break-words pt-0.5 text-sm font-semibold text-highlighted" :class="expandable && !forceOpen ? 'cursor-pointer' : ''" @click="toggle">
          {{ group.title }}
        </h3>
        <UTooltip v-if="counts.questions && !cleared" :text="`${counts.questions} question${counts.questions === 1 ? '' : 's'} for you`">
          <UBadge :label="String(counts.questions)" icon="i-lucide-circle-help" color="primary" variant="subtle" size="sm" />
        </UTooltip>
        <UTooltip v-if="counts.unacknowledged && !cleared" :text="`${counts.unacknowledged} to acknowledge`">
          <UBadge :label="String(counts.unacknowledged)" icon="i-lucide-check" color="neutral" variant="subtle" size="sm" />
        </UTooltip>
        <UBadge v-if="cleared" :label="response?.dismissedAt ? 'Dismissed' : 'Cleared'" color="neutral" variant="subtle" size="sm" />
        <UBadge v-else-if="draft.dismiss" label="Dismissed" color="neutral" variant="subtle" size="sm" />
        <UBadge v-else-if="group.status" :label="STATUS[group.status].label" :color="STATUS[group.status].color" variant="soft" size="sm" />
        <UButton
          v-if="canClear"
          :label="draft.acknowledge ? 'Clearing' : 'Clear'"
          :icon="draft.acknowledge ? 'i-lucide-check-check' : 'i-lucide-check'"
          :color="draft.acknowledge ? 'primary' : 'neutral'"
          :variant="draft.acknowledge ? 'soft' : 'outline'"
          size="xs"
          :aria-pressed="!!draft.acknowledge"
          :aria-label="`Clear ${group.title}`"
          @click="setDraft(draft.acknowledge ? null : 'acknowledge')"
        />
        <UButton
          v-if="acting && draft.dismiss"
          label="Keep it"
          icon="i-lucide-undo-2"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="setDraft(null)"
        />
        <UDropdownMenu v-if="acting && menu[0]!.length" :items="menu">
          <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" :aria-label="`More on ${group.title}`" />
        </UDropdownMenu>
      </div>
      <p v-if="group.summary" class="ms-7 text-xs text-muted">
        {{ group.summary }}
      </p>
      <p v-if="showContents || updatedAt" class="ms-7 text-xs text-dimmed">
        <span v-if="showContents">{{ contents }}</span>
        <span v-if="showContents && updatedAt"> · </span>
        <span v-if="updatedAt" :title="updatedAt">updated {{ relativeTime(updatedAt) }}</span>
      </p>
      <div v-if="links.length && !folded" class="ms-7 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
        <template v-for="(link, index) in links" :key="index">
          <ULink v-if="link.to" :to="link.to" class="inline-flex max-w-full items-center gap-1 text-xs text-muted hover:text-default">
            <UIcon :name="link.icon" class="size-3 shrink-0" />
            <span class="truncate">{{ link.label }}</span>
            <StatusDot v-if="link.status" :status="link.status"><span /></StatusDot>
          </ULink>
          <ULink v-else-if="link.href" :to="link.href" target="_blank" class="inline-flex max-w-full items-center gap-1 text-xs text-muted hover:text-default">
            <UIcon :name="link.icon" class="size-3 shrink-0" />
            <span class="truncate">{{ link.label }}</span>
          </ULink>
          <button v-else type="button" class="inline-flex max-w-full items-center gap-1 font-mono text-xs text-muted hover:text-default" :title="`Copy ${link.copy}`" @click="copy(link.copy!)">
            <UIcon :name="link.icon" class="size-3 shrink-0" />
            <span class="truncate">{{ link.label }}</span>
          </button>
        </template>
      </div>
    </div>
    <div v-if="!folded && elements.length" class="flex flex-col gap-2 border-s border-default ps-3 ms-2">
      <BoardCard v-for="element in elements" :key="element.id" :element="element" :state="state" :readonly="readonly || cleared" :since="since" />
    </div>
  </section>
</template>
