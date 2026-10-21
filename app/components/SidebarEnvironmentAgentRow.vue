<script setup lang="ts">
import { useResizeObserver } from '@vueuse/core'
import type { AgentSession, DevEnvironment } from '~~/shared/types'

/**
 * An environment with exactly one session, as one row: a nested list of one
 * spends a row and a level of indent on nothing.
 *
 * Two links, never one with a target inside it: the environment's icon goes to
 * its page, and its name slides out beside the icon on hover, keyboard focus,
 * or while that page is open, so the row keeps its width for the session's
 * name. Revealed, the environment's name gets all the room it needs and the
 * session's name gives way, down to the session's icon: the session link
 * grows from nothing (`flex-1`), so it is the first to shrink, and its floor
 * is its padding and icon (`min-w-[1.375rem]`): left to its automatic minimum,
 * that floor was the whole title, and the row ran out of the sidebar. The one menu
 * carries both sets of actions, each under its own heading.
 */
const props = defineProps<{
  environment: DevEnvironment
  agent: AgentSession
  pending?: number
  /** The environment's last segment inside its folder; the full name is its tooltip. */
  label?: string
}>()

const emit = defineEmits<{ newAgent: [] }>()

const agentActions = useAgentRowActions(() => props.agent)
const environmentActions = useEnvironmentRowActions(() => props.environment, () => emit('newAgent'))
const { retired } = environmentActions
const agentRenaming = agentActions.renaming
const environmentRenaming = environmentActions.renaming
const { confirmingRetire, retireDescription } = environmentActions

const busy = computed(() => agentActions.busy.value || environmentActions.busy.value)

/**
 * How far the environment's name opens: its whole width, or as much as the
 * session's name can give up down to the session's icon, whichever is less.
 * The name eases to exactly that. Eased toward its whole width instead, a
 * long name hit the edge of the row within two frames and the rest of the
 * motion was spent on nothing.
 */
const row = ref<HTMLElement | null>(null)
const nameClip = ref<HTMLElement | null>(null)
const agentLink = ref<{ $el: HTMLElement } | null>(null)

function measureReveal() {
  const clip = nameClip.value
  const agent = agentLink.value?.$el
  if (!row.value || !clip || !agent) return
  const natural = (clip.firstElementChild as HTMLElement | null)?.scrollWidth ?? 0
  const room = clip.offsetWidth + agent.offsetWidth - Number.parseFloat(getComputedStyle(agent).minWidth)
  row.value.style.setProperty('--env-reveal', `${Math.max(0, Math.min(natural, room))}px`)
}

// The row's width and the open page (which keeps the name out) change the answer too.
useResizeObserver(row, measureReveal)

const items = computed(() => {
  const [first = [], ...rest] = environmentActions.items(true)
  return [
    [{ type: 'label' as const, label: props.agent.title }, ...agentActions.items(true)],
    [{ type: 'label' as const, label: props.environment.name }, ...first],
    ...rest
  ]
})
</script>

<template>
  <div ref="row" :class="ROW_CLASS">
    <SidebarDisclosure :expanded="false" :label="environment.name" empty />

    <NuxtLink
      :to="`/environments/${environment.id}`"
      class="group/env flex min-w-0 items-center self-stretch rounded-md"
      active-class="row-active"
      :title="environment.name"
      @pointerenter="measureReveal"
      @focusin="measureReveal"
    >
      <EnvironmentIcon :status="environment.status" />
      <span
        ref="nameClip"
        class="block min-w-0 max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-(--motion-base) group-hover/env:max-w-(--env-reveal) group-hover/env:opacity-100 group-focus-visible/env:max-w-(--env-reveal) group-focus-visible/env:opacity-100 group-[.row-active]/env:max-w-(--env-reveal) group-[.row-active]/env:opacity-100 motion-reduce:transition-opacity"
        :class="retired ? 'text-dimmed' : 'text-muted'"
      >
        <span class="block truncate ps-1.5">{{ label ?? environment.name }}</span>
      </span>
    </NuxtLink>

    <NuxtLink
      ref="agentLink"
      :to="`/agents/${agent.id}`"
      class="flex min-w-[1.375rem] flex-1 items-center gap-2 self-stretch rounded-md ps-1.5 text-sm"
      active-class="row-active"
      :title="agent.title"
    >
      <AgentStatusIcon :status="agent.status" />
      <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
      <BoardUnseenDot :owner-id="agent.assistantId ?? agent.id" />
    </NuxtLink>

    <UChip
      v-if="pending"
      :text="pending"
      color="warning"
      size="sm"
      standalone
      :class="ROW_BADGE_CLASS"
    />

    <UButton
      v-if="!retired"
      icon="i-lucide-plus"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="`New session in ${environment.name}`"
      :class="ROW_QUICK_ACTION_CLASS"
      @click="emit('newAgent')"
    />

    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        size="xs"
        :loading="busy"
        :aria-label="`Actions for ${agent.title} in ${environment.name}`"
        :class="ROW_MENU_CLASS"
      />
    </UDropdownMenu>

    <RenameModal
      v-model:open="agentRenaming"
      title="Rename agent"
      description="Changes what this coding agent is called in Domo and out loud."
      :initial="agent.title"
      @submit="agentActions.rename"
    />

    <RenameModal
      v-model:open="environmentRenaming"
      title="Rename environment"
      description="Changes the name shown in Domo, and the folder it is grouped in. The container, its worktree and its branch keep the names they were created with."
      :initial="environment.name"
      @submit="environmentActions.rename"
    />

    <ConfirmModal
      v-model:open="confirmingRetire"
      :title="`Retire ${environment.name}?`"
      :description="retireDescription"
      confirm-label="Retire environment"
      :loading="environmentActions.busy.value"
      @confirm="environmentActions.retire"
    />
  </div>
</template>
