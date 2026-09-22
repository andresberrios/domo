<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

/**
 * One coding agent in the tree: a link that is the whole accessible name of the
 * row, and an actions menu beside it. Nothing here is a button inside a link.
 */
const props = defineProps<{ agent: AgentSession, pending?: number }>()

const toast = useToast()
const renaming = ref(false)
const busy = ref(false)

async function patch(body: Record<string, unknown>, failure: string) {
  busy.value = true
  try {
    await $fetch(`/api/agents/${props.agent.id}`, { method: 'PATCH', body })
  } catch (error: any) {
    toast.add({ title: failure, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

async function rename(title: string) {
  renaming.value = false
  await patch({ title }, 'Could not rename the agent')
}

async function archive() {
  // The row leaves the tree unless "Show archived sessions" is on, and its
  // transcript is kept either way.
  await patch({ archived: props.agent.archived ? false : true }, 'Could not archive the agent')
}

async function stop() {
  busy.value = true
  try {
    await $fetch(`/api/agents/${props.agent.id}/cancel`, { method: 'POST' })
  } catch (error: any) {
    toast.add({ title: 'Could not stop the agent', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

const items = computed(() => [[
  { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } },
  { label: 'Stop', icon: 'i-lucide-square', onSelect: () => stop() },
  props.agent.archived
    ? { label: 'Unarchive', icon: 'i-lucide-archive-restore', onSelect: () => archive() }
    : { label: 'Archive', icon: 'i-lucide-archive', onSelect: () => archive() }
]])
</script>

<template>
  <div class="group flex items-center gap-1 rounded-md pe-1 hover:bg-elevated has-[a.row-active]:bg-elevated has-[a.row-active]:font-medium">
    <NuxtLink
      :to="`/agents/${agent.id}`"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm"
      active-class="row-active"
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
        :class="ROW_ACTIONS_CLASS"
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
