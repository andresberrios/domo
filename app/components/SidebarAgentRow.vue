<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

/**
 * One coding agent in the tree: a link that is the whole accessible name of the
 * row, and an actions menu beside it. Nothing here is a button inside a link.
 */
const props = defineProps<{ agent: AgentSession, pending?: number }>()

const { busy, renaming, rename, items: actions } = useAgentRowActions(() => props.agent)
const items = computed(() => [actions()])
</script>

<template>
  <div :class="ROW_CLASS">
    <!-- Nothing to open, but the chevron's slot all the same: every row of a level has its icon in one column. -->
    <SidebarDisclosure :expanded="false" :label="agent.title" empty />
    <NuxtLink
      :to="`/agents/${agent.id}`"
      class="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-sm"
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

    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        size="xs"
        :loading="busy"
        :aria-label="`Actions for ${agent.title}`"
        :class="ROW_MENU_CLASS"
      />
    </UDropdownMenu>

    <RenameModal
      v-model:open="renaming"
      title="Rename agent"
      description="Changes what this coding agent is called in Domo and out loud."
      :initial="agent.title"
      @submit="rename"
    />

  </div>
</template>
