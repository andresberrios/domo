<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'

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

/**
 * The session is read the same way everything else on this page is: off the
 * shape. There used to be a `GET /api/agents/:id` beside it, to put a title on
 * screen a moment sooner, but it fetched a row the browser was already being
 * sent — and every write below had to remember to re-fetch it, which is a
 * second way for the page to be right and a second way for it to be stale.
 */
const session = computed<AgentSession | null>(() => synced.value)

/**
 * The environment *including* a retired one, whatever the sidebar switch says.
 * A session's whole point is that it still says where it ran, and the banner
 * needs the retired row to explain why it cannot be started.
 */
const environment = computed(() =>
  allEnvironments.value.find(item => item.id === session.value?.devEnvironmentId) ?? null
)
/** The agent that spawned this one over the mesh: the edge its cross-agent powers follow. */
const { all: allSessions } = useAgentSessions()
const spawner = computed(() => {
  const id = session.value?.spawnedBy
  return id ? { id, title: allSessions.value.find(item => item.id === id)?.title ?? id } : null
})
/** The assistant this session is one chapter of, and whether it has since handed off. */
const { assistant } = useAssistant(() => session.value?.assistantId)
const handedOff = computed(() => !!assistant.value && assistant.value.currentSessionId !== session.value?.id)
const startability = useSessionStartability(session)
/**
 * Set only when the session cannot run; the sentence to show for it. A
 * session that handed off can run, but what is said to it goes to the
 * assistant, so its page is a record and offers nothing to send.
 */
const blocked = computed(() => startability.value.startable ? null : startability.value.reason)
const closed = computed(() => !!blocked.value || handedOff.value)
const adapter = computed(() => session.value ? agentAdapterInfo(session.value.adapter) : null)
const usageProvider = computed(() => session.value?.adapter === 'claude-code'
  ? 'claude' as const
  : session.value?.adapter === 'codex'
    ? 'codex' as const
    : session.value?.adapter === 'opencode'
      ? 'opencode' as const
      : undefined)


/**
 * Whether the voice bar is open. Remembered across pages and reloads: someone
 * who talks to their agents does not want to find the microphone every time.
 */
const voiceOpen = useAgentVoiceOpen()

const renaming = ref(false)
const titleDraft = ref('')
const starting = ref(false)
const confirmingPurge = ref(false)

async function start() {
  starting.value = true
  try {
    await $fetch(`/api/agents/${agentId.value}/start`, { method: 'POST' })
  } catch (error: any) {
    toast.add({
      title: 'Could not start the agent',
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
}

async function archive() {
  await $fetch(`/api/agents/${agentId.value}`, { method: 'PATCH', body: { archived: true } })
  toast.add({
    title: 'Agent archived',
    description: 'Choose "Show archived" in the eye menu beside Projects to find it again.',
    color: 'neutral'
  })
  await router.push('/')
}

async function unarchive() {
  await $fetch(`/api/agents/${agentId.value}`, { method: 'PATCH', body: { archived: false } })
  toast.add({ title: 'Agent unarchived', color: 'neutral' })
}

async function purge() {
  confirmingPurge.value = false
  try {
    await $fetch(`/api/agents/${agentId.value}?purge=true`, { method: 'DELETE' })
    toast.add({ title: 'Agent deleted', description: 'Its transcript is gone.', color: 'neutral' })
    await router.push('/')
  } catch (error: any) {
    toast.add({ title: 'Could not delete the agent', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  }
}

const menuItems = computed(() => [
  { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { titleDraft.value = session.value?.title ?? ''; renaming.value = true } },
  // A session that cannot start has nothing to restart.
  ...closed.value ? [] : [{ label: 'Restart agent', icon: 'i-lucide-rotate-ccw', onSelect: start }],
  session.value?.archived
    ? { label: 'Unarchive', icon: 'i-lucide-archive-restore', onSelect: unarchive }
    : { label: 'Archive', icon: 'i-lucide-archive', onSelect: archive },
  // Only from the archive: a transcript is never destroyed off the live list.
  ...session.value?.archived
    ? [{ label: 'Delete permanently', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { confirmingPurge.value = true } }]
    : []
])
</script>

<template>
  <UDashboardPanel id="agent">
    <template #header>
      <UDashboardNavbar icon="i-lucide-bot">
        <template #title>
          <span class="truncate">{{ session?.title ?? 'Agent' }}</span>
        </template>

        <template #trailing>
          <UBadge v-if="session?.archived" color="neutral" variant="subtle" size="sm" label="Archived" />
          <StatusDot v-if="session" :status="session.status" />
        </template>

        <template #right>
          <UsageMeter
            :usage="session?.usage ?? null"
            :provider="usageProvider"
          />
          <UButton
            v-if="session && !closed && (session.status === 'stopped' || session.status === 'error')"
            :label="'Start'"
            icon="i-lucide-play"
            size="sm"
            :loading="starting"
            :ui="{ label: 'hidden sm:inline' }"
            @click="start"
          />
          <UTooltip v-if="!closed" :text="voiceOpen ? 'Close the voice bar' : 'Talk to this agent'">
            <UButton
              icon="i-lucide-mic"
              :color="voiceOpen ? 'primary' : 'neutral'"
              :variant="voiceOpen ? 'soft' : 'ghost'"
              :aria-label="voiceOpen ? 'Close the voice bar' : 'Talk to this agent'"
              @click="voiceOpen = !voiceOpen"
            />
          </UTooltip>
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
            :label="adapter?.label ?? 'Coding agent'"
          />
          <UBadge
            v-if="environment"
            :color="environment.retiredAt ? 'neutral' : 'primary'"
            variant="subtle"
            size="sm"
            :label="environment.retiredAt ? `${environment.name} (retired)` : environment.name"
          >
            <template #leading><UIcon name="i-lucide-monitor" class="size-3" /></template>
          </UBadge>
          <UBadge
            v-if="assistant"
            color="primary"
            variant="subtle"
            size="sm"
            :label="handedOff ? `${assistant.name}, an earlier session` : `${assistant.name}'s current session`"
            as="NuxtLink"
            :to="`/assistants/${assistant.id}`"
          >
            <template #leading><UAvatar :src="assistant.avatar ?? undefined" :alt="assistant.name" size="3xs" /></template>
          </UBadge>
          <UBadge
            v-if="spawner"
            color="neutral"
            variant="subtle"
            size="sm"
            :label="`Started by ${spawner.title}`"
            as="NuxtLink"
            :to="`/agents/${spawner.id}`"
          >
            <template #leading><UIcon name="i-lucide-git-fork" class="size-3" /></template>
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
        <AgentUnstartableBanner v-if="session && blocked" :session="session" :reason="blocked" />
        <UAlert
          v-else-if="assistant && handedOff"
          icon="i-lucide-notebook-pen"
          color="neutral"
          variant="subtle"
          :title="`This session handed off. ${assistant.name} carries on in a newer one.`"
          description="It is kept as a record. Anything sent to it goes to the current session."
          :actions="[{ label: `Open ${assistant.name}`, to: `/assistants/${assistant.id}`, trailingIcon: 'i-lucide-arrow-right' }]"
          class="mb-2"
        />
        <AgentErrorBanner v-else-if="session" :session="session" />

        <div v-if="!events.length && session?.status !== 'thinking'" class="flex flex-1 items-center justify-center">
          <div class="max-w-sm text-center">
            <UIcon name="i-lucide-bot" class="mx-auto size-8 text-dimmed" />
            <p class="mt-3 text-sm font-medium">
              Nothing here yet
            </p>
            <p class="mt-1 text-sm text-muted">
              {{ blocked
                ? 'It never did anything, and it can no longer be started.'
                : 'Send this agent a task below, or open the voice bar and say it.' }}
            </p>
          </div>
        </div>

        <!--
          The transcript owns its scroll box, because the virtualiser inside it
          measures rows against that element. `min-h-0` is what keeps it inside
          this flex column: without it the box grows to its content, the
          dashboard body scrolls instead, and the pinned permission cards and
          the composer paint on top of the messages.
        -->
        <AgentTranscript
          v-else-if="session"
          class="min-h-0 flex-1"
          :session="session"
          :events="events"
          :permissions="permissions"
          :condensed="condensed"
        />

        <div v-if="pending.length && !blocked" class="mx-auto max-h-[40vh] w-full max-w-3xl shrink-0 space-y-2 overflow-y-auto border-t border-default py-2">
          <PermissionCard
            v-for="permission in pending"
            :key="permission.id"
            :permission="permission"
          />
        </div>

        <!--
          Still rendered when the session cannot run: what was waiting when its
          environment went away is part of the record. `readonly` drops the
          take-back button, which would be the one thing left on this page that
          still wrote to a session nothing can reach.
        -->
        <div v-if="queued.length" class="shrink-0 pt-2">
          <AgentInbox :agent-session-id="agentId" :messages="queued" :readonly="!!blocked" />
        </div>

        <div v-if="!closed && voiceOpen && session" class="shrink-0 pt-2">
          <AgentVoiceBar :session="session" />
        </div>

        <div v-if="!closed" class="shrink-0 pt-2">
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
          v-model:open="confirmingPurge"
          :title="`Delete ${session?.title} permanently?`"
          description="Deletes this agent and its whole transcript. This cannot be undone."
          confirm-label="Delete permanently"
          @confirm="purge"
        />
    </template>
  </UDashboardPanel>
</template>
