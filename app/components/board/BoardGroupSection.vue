<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import type { BoardState } from '~/composables/useBoard'
import type { BoardElement, BoardGroup, BoardGroupStatus } from '~~/shared/types/board'
import { attention, isFolded } from '~~/shared/board'

/**
 * One workstream: a header that says where it stands and where the human is
 * needed, the agents and branches doing it, and its elements, folded as the
 * human left it (a done group starts folded).
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
}>()

const STATUS: Record<BoardGroupStatus, { label: string, color: 'primary' | 'warning' | 'error' | 'success' | 'neutral' }> = {
  active: { label: 'Active', color: 'primary' },
  waiting: { label: 'Waiting on you', color: 'warning' },
  blocked: { label: 'Blocked', color: 'error' },
  done: { label: 'Done', color: 'success' }
}

const folds = computed(() => props.state.board.value?.folds ?? {})
/** Folded here at once; the row catches up when it comes back. */
const local = ref<boolean | null>(null)
watch(() => folds.value[props.group.title], () => { local.value = null })
const folded = computed(() => !props.forceOpen && (local.value ?? isFolded(props.group, folds.value)))
function toggle() {
  local.value = !folded.value
  void props.state.setFolded(props.group.title, local.value)
}

const counts = computed(() => attention(props.all.filter(element => element.group === props.group.title && !element.response.dismissedAt)))

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
    <div class="-mx-1 rounded-md px-1 pt-1">
      <div class="flex items-center gap-1.5">
        <UButton
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
        <h3 class="min-w-0 flex-1 cursor-pointer truncate text-sm font-semibold text-highlighted" @click="forceOpen || toggle()">
          {{ group.title }}
        </h3>
        <UTooltip v-if="counts.questions" :text="`${counts.questions} question${counts.questions === 1 ? '' : 's'} for you`">
          <UBadge :label="String(counts.questions)" icon="i-lucide-circle-help" color="primary" variant="subtle" size="sm" />
        </UTooltip>
        <UTooltip v-if="counts.unacknowledged" :text="`${counts.unacknowledged} to acknowledge`">
          <UBadge :label="String(counts.unacknowledged)" icon="i-lucide-check" color="neutral" variant="subtle" size="sm" />
        </UTooltip>
        <UBadge v-if="group.status" :label="STATUS[group.status].label" :color="STATUS[group.status].color" variant="soft" size="sm" />
      </div>
      <p v-if="group.summary" class="ms-7 text-xs text-muted" :class="folded ? 'truncate' : ''">
        {{ group.summary }}
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
      <BoardCard v-for="element in elements" :key="element.id" :element="element" :state="state" :readonly="readonly" :since="since" />
    </div>
  </section>
</template>
