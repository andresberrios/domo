<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

/**
 * One coding agent in the tree: a link that is the whole accessible name of the
 * row, and an actions menu beside it. Nothing here is a button inside a link.
 */
const props = defineProps<{ agent: AgentSession, pending?: number }>()

const toast = useToast()
const renaming = ref(false)
const confirmingRetire = ref(false)
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
  // The row disappears from the tree: `useAgentSessions()` filters archived out.
  // It is still findable — and unarchivable — on /archive.
  await patch({ archived: true }, 'Could not archive the agent')
}

/** Ends the session and keeps its transcript. See server/lib/session-retention.ts. */
async function retire() {
  confirmingRetire.value = false
  busy.value = true
  try {
    await $fetch(`/api/agents/${props.agent.id}`, { method: 'DELETE' })
  } catch (error: any) {
    toast.add({ title: 'Could not retire the agent', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
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
  { label: 'Archive', icon: 'i-lucide-archive', onSelect: () => archive() }
], [
  { label: 'Retire', icon: 'i-lucide-box', color: 'error' as const, onSelect: () => { confirmingRetire.value = true } }
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

    <ConfirmModal
      v-model:open="confirmingRetire"
      :title="`Retire ${agent.title}?`"
      description="Stops the adapter and takes the session off the list for good, cancelling its schedules and subscriptions. Its transcript is kept and stays readable in the archive, and it can be revived while the environment it ran in still exists."
      confirm-label="Retire session"
      :loading="busy"
      @confirm="retire"
    />
  </div>
</template>
