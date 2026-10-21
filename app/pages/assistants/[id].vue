<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'

/**
 * One assistant: one continuous conversation, however many sessions it has
 * been through. The transcript is its sessions' logs read as one, with a
 * divider where each took over; the composer, with its voice mode and its
 * context gauge, belongs to the session it is in now.
 */
const route = useRoute()
const router = useRouter()
const toast = useToast()

const assistantId = computed(() => route.params.id as string)
const { assistant } = useAssistant(assistantId)
const { all: allSessions } = useAgentSessions()
const { all: allEnvironments } = useDevEnvironments()
const { permissions: allPermissions } = usePermissions()

/** Its sessions, oldest first. */
const sessions = computed<AgentSession[]>(() =>
  allSessions.value
    .filter(session => session.assistantId === assistantId.value)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
)
const current = computed(() =>
  sessions.value.find(session => session.id === assistant.value?.currentSessionId) ?? null
)

/**
 * Only the session it is in now is on screen. Earlier ones are read from the
 * journal, each on its own page, which says it handed off and links back here.
 */
const shownSessions = computed(() => current.value ? [current.value] : [])
const { events, complete, loadingEarlier, loadEarlier } = useSessionsEvents(() => shownSessions.value.map(session => session.id))

/** Whether anything has been said yet: a fresh assistant's log holds only notices. */
const conversed = computed(() => events.value.some(event => event.type === 'user_message' || event.type === 'agent_message'))

const sessionIds = computed(() => new Set(shownSessions.value.map(session => session.id)))
const permissions = computed(() => allPermissions.value.filter(permission => sessionIds.value.has(permission.agentSessionId)))
const pending = computed(() => permissions.value.filter(permission =>
  !permission.resolvedAt && permission.agentSessionId === current.value?.id))
const { queued } = useAgentInbox(() => current.value?.id)

const environment = computed(() =>
  allEnvironments.value.find(item => item.id === current.value?.devEnvironmentId) ?? null)
const startability = useSessionStartability(current)
const blocked = computed(() => startability.value.startable ? null : startability.value.reason)
const adapter = computed(() => current.value ? agentAdapterInfo(current.value.adapter) : null)
const avatar = computed(() => assistant.value ? { src: assistant.value.avatar ?? undefined, alt: assistant.value.name } : undefined)

const handingOff = computed(() => !!assistant.value?.handoff)
const freshStartPending = ref(false)
/** A fresh start replaces the conversation in context, so one stray tap must not trigger it. */
const confirmingFreshStart = ref(false)
const editing = ref(false)
const journalOpen = ref(false)

async function freshStart() {
  confirmingFreshStart.value = false
  freshStartPending.value = true
  try {
    const answer = await $fetch<{ started: boolean, note?: string }>(`/api/assistants/${assistantId.value}/handoff`, { method: 'POST' })
    if (!answer.started && answer.note) toast.add({ title: answer.note, color: 'neutral' })
  } catch (error: any) {
    toast.add({ title: 'Could not start fresh', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    freshStartPending.value = false
  }
}

/** Its name, which is also its current session's title. */
async function rename(name: string) {
  try {
    await $fetch(`/api/assistants/${assistantId.value}`, { method: 'PATCH', body: { name } })
  } catch (error: any) {
    toast.add({ title: 'Could not rename the assistant', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
  }
}

async function setArchived(archived: boolean) {
  try {
    await $fetch(`/api/assistants/${assistantId.value}`, { method: 'PATCH', body: { archived } })
    if (archived) {
      toast.add({ title: `${assistant.value?.name} archived`, description: 'Choose "Show archived" in the eye menu beside Projects to find it again.', color: 'neutral' })
      await router.push('/')
    }
  } catch (error: any) {
    toast.add({ title: 'Could not change the assistant', description: error?.data?.message ?? error?.message, color: 'error' })
  }
}

const menuItems = computed(() => [
  { label: 'Edit', icon: 'i-lucide-pencil', onSelect: () => { editing.value = true } },
  { label: 'Journal', icon: 'i-lucide-book-open', onSelect: () => { journalOpen.value = true } },
  assistant.value?.archived
    ? { label: 'Unarchive', icon: 'i-lucide-archive-restore', onSelect: () => setArchived(false) }
    : { label: 'Archive', icon: 'i-lucide-archive', onSelect: () => setArchived(true) }
])
</script>

<template>
  <UDashboardPanel id="assistant">
    <template #header>
      <UDashboardNavbar>
        <template #title>
          <span class="flex min-w-0 items-center gap-2">
            <UAvatar :src="assistant?.avatar ?? undefined" :alt="assistant?.name ?? '?'" size="xs" />
            <InlineTitle v-if="assistant" :value="assistant.name" label="Assistant name" @save="rename" />
            <span v-else class="truncate">Assistant</span>
          </span>
        </template>

        <template #trailing>
          <UBadge v-if="assistant?.archived" color="neutral" variant="subtle" size="sm" label="Archived" />
          <StatusDot v-if="current" :status="current.status" />
        </template>

        <template #right>
          <UTooltip :text="handingOff ? 'Writing a note for a fresh session…' : 'Have it write itself a note and carry on in a fresh session'">
            <UButton
              :label="handingOff ? 'Handing off' : 'Fresh start'"
              icon="i-lucide-notebook-pen"
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="handingOff || freshStartPending"
              :disabled="!current || !!blocked || assistant?.archived"
              :ui="{ label: 'hidden sm:inline' }"
              @click="confirmingFreshStart = true"
            />
          </UTooltip>
          <UDropdownMenu :items="menuItems">
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" aria-label="Assistant actions" />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>

      <UDashboardToolbar>
        <template #left>
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="[adapter?.label, current?.model].filter(Boolean).join(' · ') || 'Coding agent'"
          />
          <UBadge v-if="environment" color="primary" variant="subtle" size="sm" :label="environment.name">
            <template #leading><UIcon name="i-lucide-monitor" class="size-3" /></template>
          </UBadge>
          <UBadge v-else-if="current" color="neutral" variant="subtle" size="sm" class="font-mono" :label="shortPath(current.cwd, 3)">
            <template #leading><UIcon name="i-lucide-folder" class="size-3" /></template>
          </UBadge>
          <UButton
            :label="`${sessions.length} session${sessions.length === 1 ? '' : 's'}`"
            icon="i-lucide-book-open"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="journalOpen = true"
          />
          <TargetSchedules :assistant-id="assistantId" />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div class="flex h-full min-h-0 flex-col">
        <ServiceBanner />
        <AgentUnstartableBanner v-if="current && blocked" :session="current" :reason="blocked" />
        <AgentErrorBanner v-else-if="current" :session="current" />

        <div v-if="!conversed && current?.status !== 'thinking'" class="flex flex-1 items-center justify-center">
          <div class="max-w-sm text-center">
            <UAvatar :src="assistant?.avatar ?? undefined" :alt="assistant?.name ?? '?'" size="3xl" class="mx-auto" />
            <p class="mt-3 text-sm font-medium">
              {{ assistant?.name }}
            </p>
            <p class="mt-1 line-clamp-3 text-sm text-muted">
              {{ assistant?.persona || 'Say hello below, or out loud.' }}
            </p>
          </div>
        </div>

        <AgentTranscript
          v-else-if="current"
          class="min-h-0 flex-1"
          :session="current"
          :events="events"
          :permissions="permissions"
          :avatar="avatar"
          :complete="complete"
          :loading-earlier="loadingEarlier"
          @load-earlier="loadEarlier"
        />

        <MotionList v-if="pending.length && !blocked" tag="div" class="mx-auto max-h-[40vh] w-full max-w-3xl shrink-0 space-y-2 overflow-y-auto border-t border-default py-2">
          <PermissionCard v-for="permission in pending" :key="permission.id" :permission="permission" />
        </MotionList>

        <div v-if="queued.length && current" class="motion-fade shrink-0 pt-2">
          <AgentInbox :agent-session-id="current.id" :messages="queued" :readonly="!!blocked" :session="current" />
        </div>

        <div v-if="!blocked && current && !assistant?.archived" class="shrink-0 pt-2">
          <AgentComposer :session="current" />
        </div>
      </div>

      <AssistantModal v-model:open="editing" :assistant="assistant" />
      <AssistantJournal v-if="assistant" v-model:open="journalOpen" :assistant="assistant" :sessions="sessions" />
      <ConfirmModal
        v-model:open="confirmingFreshStart"
        :title="`Start ${assistant?.name ?? 'the assistant'} fresh?`"
        description="It writes itself a note and carries on in a new session that starts from that note. The current conversation leaves its context."
        confirm-label="Start fresh"
        confirm-color="primary"
        @confirm="freshStart"
      />
    </template>
  </UDashboardPanel>
</template>
