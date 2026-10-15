<script setup lang="ts">
import type { AgentSession, DevEnvironment } from '~~/shared/types'

/**
 * An environment with exactly one session, as one row: a nested list of one
 * spends a row and a level of indent on nothing.
 *
 * Two links, never one with a target inside it: the environment's icon goes to
 * its page, and its name slides out beside the icon on hover, keyboard focus,
 * or while that page is open, so the row keeps its width for the session's
 * name. The one menu carries both sets of actions, each under its own heading.
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
  <div :class="ROW_CLASS">
    <SidebarDisclosure :expanded="false" :label="environment.name" empty />

    <NuxtLink
      :to="`/environments/${environment.id}`"
      class="group/env flex min-w-0 items-center self-stretch rounded-md"
      active-class="row-active"
      :title="environment.name"
    >
      <EnvironmentIcon :status="environment.status" />
      <span
        class="min-w-0 max-w-0 overflow-hidden whitespace-nowrap transition-[max-width] duration-200 group-hover/env:max-w-32 group-focus-visible/env:max-w-32 group-[.row-active]/env:max-w-32 motion-reduce:transition-none"
        :class="retired ? 'text-dimmed' : 'text-muted'"
      >
        <span class="block truncate ps-1.5">{{ label ?? environment.name }}</span>
      </span>
    </NuxtLink>

    <NuxtLink
      :to="`/agents/${agent.id}`"
      class="flex min-w-16 flex-1 items-center gap-2 self-stretch rounded-md ps-1.5 text-sm"
      active-class="row-active"
      :title="agent.title"
    >
      <AgentStatusIcon :status="agent.status" />
      <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
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
