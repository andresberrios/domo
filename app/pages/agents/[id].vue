<script setup lang="ts">
import type { AgentDraft, AgentEvent, AgentSession } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'
import { agentPageKey, draftRequest, freshDraftPage, initialDraft, promoteDraftPage } from '~/utils/agentDraft'
import { rememberDraftSettings, rememberedDraftSettings } from '~/composables/rememberedDraft'

/**
 * One session — or, at `/agents/new`, one that does not exist yet.
 *
 * A draft is this same page with no row behind it: the composer with its
 * settings card, and a panel above it for where the session works. Its first
 * message creates the session, and the address moves onto it without the page
 * being built again (`agentPageKey`), so what was typed, the message just sent
 * and the reply streaming under it are all on the page that was already open.
 */
definePageMeta({
  key: agentPageKey,
  middleware: (to) => {
    if (to.params.id === 'new') freshDraftPage()
  }
})

const route = useRoute()
const router = useRouter()
const toast = useToast()

const agentId = computed(() => route.params.id as string)
const isDraft = computed(() => agentId.value === 'new')
/** The session's id, once there is one; nothing is synced for a draft. */
const sessionId = computed(() => isDraft.value ? null : agentId.value)

const { session: synced } = useAgentSession(sessionId)
const { all: allEnvironments, environments, isReady: environmentsReady } = useDevEnvironments()
const { events, complete, loadingEarlier, loadEarlier } = useAgentEvents(sessionId)
const { permissions, pending } = usePermissions(agentId)
const { queued } = useAgentInbox(sessionId)

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
const { all: allSessions } = useAgentSessions()

/* ------------------------------ the draft ------------------------------ */

const { projects, all: allProjects, isReady: projectsReady } = useProjects()
const { data: settings } = useSettings()
const draft = ref<AgentDraft | null>(null)

// Made once the projects and environments are in, because where it starts —
// the address's project or environment, else a running one — is read off them.
watch([isDraft, projectsReady, environmentsReady], () => {
  if (!isDraft.value || draft.value || !projectsReady.value || !environmentsReady.value) return
  draft.value = initialDraft(
    { project: route.query.project as string | undefined, environment: route.query.environment as string | undefined },
    projects.value,
    environments.value,
    settings.value?.defaultCwd,
    rememberedDraftSettings()
  )
}, { immediate: true })

const draftEnvironment = computed(() => environments.value.find(item => item.id === draft.value?.devEnvironmentId) ?? null)

const creating = ref(false)
const createError = ref<string | null>(null)

/**
 * The first message, from the moment it is sent until the transcript has its
 * own record of it.
 *
 * The session's row and the message are written at once, but the message only
 * reaches the transcript when the adapter has booted and taken it from the
 * inbox — seconds, or the start of a container. Without this the message
 * would vanish from the composer and reappear later; with it, it stays where
 * it will be. A boot that fails leaves it in the inbox, and the inbox shows it.
 */
const firstMessage = ref<{ content: any[], at: string } | null>(null)

const shownEvents = computed<AgentEvent[]>(() => {
  const sent = firstMessage.value
  if (!sent) return events.value
  return [...events.value, {
    id: 'first-message',
    agentSessionId: sessionId.value ?? 'new',
    seq: Number.MAX_SAFE_INTEGER,
    type: 'user_message',
    payload: { content: sent.content },
    createdAt: sent.at
  }]
})

watch([events, () => synced.value?.status], () => {
  if (!firstMessage.value || !synced.value) return
  const delivered = events.value.some(event => event.type === 'user_message')
  if (delivered || synced.value.status === 'error' || synced.value.status === 'stopped') firstMessage.value = null
})

/** The new session's row, once Electric has brought it: the page has nothing to show before. */
function rowArrives(id: string): Promise<void> {
  const arrived = () => allSessions.value.some(item => item.id === id)
  if (arrived()) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, 15_000)
    const stop = watch(allSessions, () => {
      if (arrived()) done()
    })
    function done() {
      clearTimeout(timer)
      stop()
      resolve()
    }
  })
}

/**
 * What the composer's send does on a draft: make the session, with this as its
 * first message, and move onto it. False when it could not be made — the draft
 * stays as it was and the message goes back into the composer.
 */
async function startFromDraft(content: any[]): Promise<boolean> {
  if (!draft.value || creating.value) return false
  creating.value = true
  createError.value = null
  firstMessage.value = { content, at: new Date().toISOString() }
  try {
    const created = await $fetch<{ id: string }>('/api/agents', {
      method: 'POST',
      body: draftRequest(draft.value, content)
    })
    // The next draft starts from these; see `rememberedDraftSettings`.
    rememberDraftSettings(draft.value)
    await rowArrives(created.id)
    // Somebody who went elsewhere meanwhile is not pulled back; the session is
    // in the sidebar.
    if (isDraft.value) {
      promoteDraftPage(created.id)
      // Replaced, so Back does not return to an empty draft.
      await router.replace(`/agents/${created.id}`)
    }
    return true
  } catch (error: any) {
    firstMessage.value = null
    createError.value = error?.data?.statusMessage ?? error?.data?.message ?? error?.message ?? 'The server did not say why.'
    return false
  } finally {
    creating.value = false
  }
}

/* ----------------------------- the session ----------------------------- */

/** The agent that spawned this one over the mesh: the edge its cross-agent powers follow. */
const spawner = computed(() => {
  const id = session.value?.spawnedBy
  return id ? { id, title: allSessions.value.find(item => item.id === id)?.title ?? id } : null
})
/** The assistant this session is one chapter of, and whether it has since handed off. */
const { assistant } = useAssistant(() => session.value?.assistantId)
const handedOff = computed(() => !!assistant.value && assistant.value.currentSessionId !== session.value?.id)

const { all: allAssistants } = useAssistants()
provideDomoNames({
  // An agent may write to an assistant (`as_…`) as well as to a session.
  agent: id => allSessions.value.find(item => item.id === id)?.title
    ?? allAssistants.value.find(item => item.id === id)?.name ?? null,
  environment: id => allEnvironments.value.find(item => item.id === id)?.name ?? null,
  project: id => allProjects.value.find(item => item.id === id)?.name ?? null
})
const startability = useSessionStartability(session)
/**
 * Set only when the session cannot run; the sentence to show for it. A
 * session that handed off can run, but what is said to it goes to the
 * assistant, so its page is a record and offers nothing to send.
 */
const blocked = computed(() => startability.value.startable ? null : startability.value.reason)
const closed = computed(() => !!blocked.value || handedOff.value)
const adapter = computed(() => session.value ? agentAdapterInfo(session.value.adapter) : null)
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

/** The header's own rename: the same PATCH as the menu's, so the title is the user's from then on. */
async function renameTo(title: string) {
  try {
    await $fetch(`/api/agents/${agentId.value}`, { method: 'PATCH', body: { title } })
  } catch (error: any) {
    toast.add({ title: 'Could not rename the agent', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
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
          <InlineTitle v-if="session" :value="session.title" label="Session title" @save="renameTo" />
          <span v-else class="truncate">{{ isDraft ? 'New session' : 'Agent' }}</span>
        </template>

        <template #trailing>
          <UBadge v-if="session?.archived" color="neutral" variant="subtle" size="sm" label="Archived" />
          <StatusDot v-if="session" :status="session.status" />
        </template>

        <template #right>
          <UButton
            v-if="session && !closed && (session.status === 'stopped' || session.status === 'error')"
            :label="'Start'"
            icon="i-lucide-play"
            size="sm"
            :loading="starting"
            :ui="{ label: 'hidden sm:inline' }"
            @click="start"
          />
          <UDropdownMenu v-if="session" :items="menuItems">
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar>
        <template #left>
          <!--
            A draft says where it is about to work in the same places a session
            says where it works, so the bar does not jump when it becomes one.
          -->
          <UBadge v-if="session || (draft && !draft.devEnvironmentId)" color="neutral" variant="subtle" size="sm" class="font-mono">
            <UIcon name="i-lucide-folder" class="me-1 size-3" />
            {{ session?.cwd ?? draft?.cwd }}
          </UBadge>
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="adapter?.label ?? (draft ? agentAdapterInfo(draft.adapter).label : 'Coding agent')"
          />
          <UBadge
            v-if="!session && draftEnvironment"
            color="primary"
            variant="subtle"
            size="sm"
            :label="draftEnvironment.name"
          >
            <template #leading><UIcon name="i-lucide-monitor" class="size-3" /></template>
          </UBadge>
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
          <TargetSchedules v-if="session" :agent-session-id="session.id" :assistant-id="handedOff ? null : assistant?.id" />
        </template>
        <template #right>
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

        <div v-if="isDraft && !firstMessage" class="flex flex-1 items-center justify-center">
          <div class="max-w-sm text-center">
            <UIcon name="i-lucide-bot" class="mx-auto size-8 text-dimmed" />
            <p class="mt-3 text-sm font-medium">
              A new session
            </p>
            <p class="mt-1 text-sm text-muted">
              Choose where it works and which agent and model below, then send it its first task.
              Sending is what starts it.
            </p>
          </div>
        </div>

        <div v-else-if="!shownEvents.length && session?.status !== 'thinking'" class="flex flex-1 items-center justify-center">
          <div class="max-w-sm text-center">
            <UIcon name="i-lucide-bot" class="mx-auto size-8 text-dimmed" />
            <p class="mt-3 text-sm font-medium">
              Nothing here yet
            </p>
            <p class="mt-1 text-sm text-muted">
              {{ blocked
                ? 'It never did anything, and it can no longer be started.'
                : 'Send this agent a task below, or tap the microphone and say it.' }}
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
          v-else-if="session || firstMessage"
          class="min-h-0 flex-1"
          :session="session"
          :events="shownEvents"
          :permissions="permissions"
          :complete="complete"
          :loading-earlier="loadingEarlier"
          @load-earlier="loadEarlier"
        />

        <MotionList v-if="pending.length && !blocked" tag="div" class="mx-auto max-h-[40vh] w-full max-w-3xl shrink-0 space-y-2 overflow-y-auto border-t border-default py-2">
          <PermissionCard
            v-for="permission in pending"
            :key="permission.id"
            :permission="permission"
          />
        </MotionList>

        <!--
          Still rendered when the session cannot run: what was waiting when its
          environment went away is part of the record. `readonly` drops the
          take-back button, which would be the one thing left on this page that
          still wrote to a session nothing can reach.
        -->
        <!-- The first message is in the transcript already while it waits there. -->
        <div v-if="queued.length && !firstMessage" class="motion-fade shrink-0 pt-2">
          <AgentInbox :agent-session-id="agentId" :messages="queued" :readonly="!!blocked" :session="session" />
        </div>

        <div v-if="isDraft && draft" class="shrink-0 space-y-2 pt-2">
          <UAlert
            v-if="createError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            title="Could not start the session"
            :description="createError"
            class="mx-auto max-w-3xl"
            :close="{ color: 'neutral', variant: 'link' }"
            @update:open="createError = null"
          />
          <AgentDraftPanel v-model="draft" :disabled="creating" />
        </div>

        <!--
          One composer for the draft and the session it becomes: it is the
          same component either way, so it is not rebuilt at the moment the
          session appears.
        -->
        <div v-if="!closed && (session || draft)" class="shrink-0 pt-2">
          <AgentComposer v-model:draft="draft" :session="session" :start="startFromDraft" />
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
