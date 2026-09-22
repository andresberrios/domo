<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const agentId = computed(() => route.params.id as string)

const { session: synced } = useAgentSession(agentId)
const { all: allEnvironments } = useDevEnvironments()
const { events } = useAgentEvents(agentId)
const { permissions, pending } = usePermissions(agentId)
const { queued } = useAgentInbox(agentId)
const condensed = useCondensedTranscript()

const { data: fetched, refresh } = await useFetch<AgentSession>(
  () => `/api/agents/${agentId.value}`,
  { lazy: true }
)

/** Live-synced row wins; the fetch is only there for the first paint. */
const session = computed<AgentSession | null>(() => synced.value ?? fetched.value ?? null)

/**
 * The environment *including* a deleted one. A retired session's whole point is
 * that it still says where it ran, and the banner needs the tombstone to
 * explain why it cannot be revived.
 */
const environment = computed(() =>
  allEnvironments.value.find(item => item.id === session.value?.devEnvironmentId) ?? null
)

/** A retired session is a record: no composer, no inbox actions, no start. */
const retired = computed(() => !!session.value?.retiredAt)

const renaming = ref(false)
const titleDraft = ref('')
const starting = ref(false)
const confirmingRetire = ref(false)
const confirmingPurge = ref(false)

async function start() {
  starting.value = true
  try {
    await $fetch(`/api/agents/${agentId.value}/start`, { method: 'POST' })
    await refresh()
  } catch (error: any) {
    toast.add({
      title: 'Could not start the adapter',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    starting.value = false
  }
}

async function saveTitle() {
  if (!titleDraft.value.trim()) return
  await $fetch(`/api/agents/${agentId.value}`, { method: 'PATCH', body: { title: titleDraft.value.trim() } })
  renaming.value = false
  await refresh()
}

async function archive() {
  await $fetch(`/api/agents/${agentId.value}`, { method: 'PATCH', body: { archived: true } })
  toast.add({ title: 'Agent archived', description: 'Find it again in the archive.', color: 'neutral' })
  await router.push('/')
}

async function unarchive() {
  await $fetch(`/api/agents/${agentId.value}`, { method: 'PATCH', body: { archived: false } })
  toast.add({ title: 'Agent unarchived', color: 'neutral' })
  await refresh()
}

/** Deleting keeps the transcript now; the row becomes a record of the session. */
async function retire() {
  confirmingRetire.value = false
  try {
    await $fetch(`/api/agents/${agentId.value}`, { method: 'DELETE' })
    toast.add({
      title: 'Agent retired',
      description: 'Its transcript is kept and stays readable in the archive.',
      color: 'neutral'
    })
    await refresh()
  } catch (error: any) {
    toast.add({ title: 'Could not retire the agent', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  }
}

async function purge() {
  confirmingPurge.value = false
  try {
    await $fetch(`/api/agents/${agentId.value}?purge=true`, { method: 'DELETE' })
    toast.add({ title: 'Agent deleted', description: 'Its transcript is gone.', color: 'neutral' })
    await router.push('/archive')
  } catch (error: any) {
    toast.add({ title: 'Could not delete the agent', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  }
}

const menuItems = computed(() => {
  const rename = { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { titleDraft.value = session.value?.title ?? ''; renaming.value = true } }
  if (retired.value) {
    return [
      rename,
      { label: 'Delete permanently', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { confirmingPurge.value = true } }
    ]
  }
  return [
    rename,
    { label: 'Restart adapter', icon: 'i-lucide-rotate-ccw', onSelect: start },
    session.value?.archived
      ? { label: 'Unarchive', icon: 'i-lucide-archive-restore', onSelect: unarchive }
      : { label: 'Archive', icon: 'i-lucide-archive', onSelect: archive },
    { label: 'Retire', icon: 'i-lucide-box', color: 'error' as const, onSelect: () => { confirmingRetire.value = true } }
  ]
})
</script>

<template>
  <UDashboardPanel id="agent">
    <template #header>
      <UDashboardNavbar icon="i-lucide-bot">
        <template #title>
          <span class="truncate">{{ session?.title ?? 'Agent' }}</span>
        </template>

        <template #trailing>
          <UBadge v-if="retired" color="neutral" variant="subtle" size="sm" label="Retired" />
          <StatusDot v-else-if="session" :status="session.status" />
        </template>

        <template #right>
          <UsageMeter
            :usage="session?.usage ?? null"
            :provider="session?.adapter === 'codex' ? 'codex' : 'claude'"
          />
          <UButton
            v-if="session && !retired && (session.status === 'stopped' || session.status === 'error')"
            :label="'Start'"
            icon="i-lucide-play"
            size="sm"
            :loading="starting"
            :ui="{ label: 'hidden sm:inline' }"
            @click="start"
          />
          <UDropdownMenu :items="menuItems">
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar>
        <template #left>
          <UBadge color="neutral" variant="subtle" size="sm" class="font-mono">
            <UIcon name="i-lucide-folder" class="me-1 size-3" />
            {{ session?.cwd }}
          </UBadge>
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="`${session?.adapter === 'codex' ? 'Codex' : 'Claude Code'} · ACP`"
          />
          <UBadge
            v-if="environment"
            :color="environment.deletedAt ? 'neutral' : 'primary'"
            variant="subtle"
            size="sm"
            :label="environment.deletedAt ? `${environment.name} (deleted)` : environment.name"
          >
            <template #leading><UIcon name="i-lucide-monitor" class="size-3" /></template>
          </UBadge>
        </template>
        <template #right>
          <USwitch v-model="condensed" size="xs" label="Condensed" :ui="{ label: 'text-xs text-muted' }" />
          <span class="text-xs text-dimmed">{{ relativeTime(session?.lastActivityAt) }}</span>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div class="flex h-full min-h-0 flex-col">
        <ServiceBanner />
        <AgentRetiredBanner
          v-if="session && retired"
          :session="session"
          :environment="environment"
          @revived="refresh"
        />
        <AgentErrorBanner v-else-if="session" :session="session" @retried="refresh" />

        <div v-if="!events.length && session?.status !== 'thinking'" class="flex flex-1 items-center justify-center">
          <div class="max-w-sm text-center">
            <UIcon name="i-lucide-bot" class="mx-auto size-8 text-dimmed" />
            <p class="mt-3 text-sm font-medium">
              Nothing here yet
            </p>
            <p class="mt-1 text-sm text-muted">
              {{ retired
                ? 'This session was retired before it did anything worth keeping.'
                : 'Send this agent a task below, or tell Domo out loud what you want it to do.' }}
            </p>
          </div>
        </div>

        <!--
          The transcript must own its scroll box. Without `overflow-y-auto` here it
          spills out of its flex slot, the dashboard body scrolls instead, and the
          pinned permission cards and composer paint on top of the messages.
          The outer `relative` box (not the scroller) anchors UChatMessages'
          absolutely positioned jump-to-bottom button so it doesn't scroll away.
        -->
        <div v-else-if="session" class="relative flex min-h-0 flex-1 flex-col">
          <div class="min-h-0 flex-1 overflow-y-auto">
            <AgentTranscript
              :session="session"
              :events="events"
              :permissions="permissions"
              :condensed="condensed"
            />
          </div>
        </div>

        <div v-if="pending.length && !retired" class="mx-auto max-h-[40vh] w-full max-w-3xl shrink-0 space-y-2 overflow-y-auto border-t border-default py-2">
          <PermissionCard
            v-for="permission in pending"
            :key="permission.id"
            :permission="permission"
          />
        </div>

        <!--
          Still rendered for a retired session: what was waiting when it ended is
          part of the record. `readonly` drops the take-back button, which would
          be the one thing on this page that still wrote to a closed session.
        -->
        <div v-if="queued.length" class="shrink-0 pt-2">
          <AgentInbox :agent-session-id="agentId" :messages="queued" :readonly="retired" />
        </div>

        <div v-if="!retired" class="shrink-0 pt-2">
          <AgentComposer v-if="session" :session="session" />
        </div>
      </div>
        <UModal v-model:open="renaming" title="Rename agent" description="Give this agent session a name.">
          <template #body>
            <UInput v-model="titleDraft" class="w-full" autofocus @keydown.enter="saveTitle" />
          </template>
          <template #footer>
            <div class="flex w-full justify-end gap-2">
              <UButton label="Cancel" color="neutral" variant="ghost" @click="renaming = false" />
              <UButton label="Save" @click="saveTitle" />
            </div>
          </template>
        </UModal>

        <ConfirmModal
          v-model:open="confirmingRetire"
          :title="`Retire ${session?.title}?`"
          description="Stops the adapter, cancels its schedules and subscriptions, and takes it off the session list for good. Its transcript is kept and stays readable in the archive, and it can be revived while the environment it ran in still exists."
          confirm-label="Retire session"
          @confirm="retire"
        />

        <ConfirmModal
          v-model:open="confirmingPurge"
          :title="`Delete ${session?.title} permanently?`"
          description="Destroys the session row and every event in its transcript. This is the one action here that loses the record, and it cannot be undone."
          confirm-label="Delete permanently"
          @confirm="purge"
        />
    </template>
  </UDashboardPanel>
</template>
