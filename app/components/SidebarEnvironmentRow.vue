<script setup lang="ts">
import type { DevEnvironment } from '~~/shared/types'

/**
 * One dev environment in the tree.
 *
 * The name links to the environment's page and the chevron only toggles the
 * agent list — two separate controls, because a row that is both a link and a
 * disclosure can be neither reliably. The open state belongs to the tree, so it
 * arrives as a prop and leaves as an event.
 */
const props = defineProps<{
  environment: DevEnvironment
  expanded: boolean
  agentCount: number
  /** What the row shows: the last segment of the name inside its folder. The full name is its tooltip. */
  label?: string
}>()

const emit = defineEmits<{ toggle: [], newAgent: [] }>()

const { busy, renaming, confirmingRetire, retired, rename, retire, retireDescription, items: actions }
  = useEnvironmentRowActions(() => props.environment, () => emit('newAgent'))
const items = computed(() => actions())
</script>

<template>
  <div :class="ROW_CLASS">
    <SidebarDisclosure
      :expanded="expanded"
      :label="environment.name"
      :empty="!agentCount"
      @toggle="emit('toggle')"
    />

    <NuxtLink
      :to="`/environments/${environment.id}`"
      class="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-sm"
      active-class="row-active"
      :title="environment.name"
    >
      <EnvironmentIcon :status="environment.status" />
      <span class="min-w-0 flex-1 truncate" :class="retired ? 'text-dimmed' : ''">{{ label ?? environment.name }}</span>
    </NuxtLink>

    <span v-if="agentCount && !expanded" class="px-1 text-xs tabular-nums text-dimmed" :class="ROW_BADGE_CLASS">
      {{ agentCount }}
    </span>

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
        :aria-label="`Actions for ${environment.name}`"
        :class="ROW_MENU_CLASS"
      />
    </UDropdownMenu>

    <RenameModal
      v-model:open="renaming"
      title="Rename environment"
      description="Changes the name shown in Domo, and the folder it is grouped in. The container, its worktree and its branch keep the names they were created with."
      :initial="environment.name"
      @submit="rename"
    />

    <ConfirmModal
      v-model:open="confirmingRetire"
      :title="`Retire ${environment.name}?`"
      :description="retireDescription"
      confirm-label="Retire environment"
      :loading="busy"
      @confirm="retire"
    />
  </div>
</template>
