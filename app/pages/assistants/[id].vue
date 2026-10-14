<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'

/**
 * One assistant: one continuous conversation, however many sessions it has
 * been through. The transcript is its sessions' logs read as one, with a
 * divider where each took over; the composer, the voice bar and the context
 * meter belong to the session it is in now.
 */
const route = useRoute()
const router = useRouter()
const toast = useToast()

const assistantId = computed(() => route.params.id as string)
const { assistant } = useAssistant(assistantId)
const { all: allSessions } = useAgentSessions()
const { all: allEnvironments } = useDevEnvironments()
const { permissions: allPermissions } = usePermissions()
const condensed = useCondensedTranscript()
const voiceOpen = useAgentVoiceOpen()

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
 * How many of the newest sessions are on screen. Two by default — the one it
 * is in and the one before, so the last handoff reads in context — and one
 * more each time the reader asks. Each is a shape of its own, synced only
 * while it is shown.
 */
const shown = ref(2)
watch(assistantId, () => { shown.value = 2 })
const shownSessions = computed(() => sessions.value.slice(-shown.value))
const earlier = computed(() => Math.max(0, sessions.value.length - shown.value))
const { events: merged } = useSessionsEvents(() => shownSessions.value.map(session => session.id))

/**
 * What an earlier session said about its own ending — that it handed off,
 * that its adapter then exited — is the divider below it, said once.
 */
const events = computed(() => {
  const currentId = current.value?.id
  return merged.value.filter(event =>
    event.agentSessionId === currentId || (event.type !== 'handed_off' && event.type !== 'adapter-exit'))
})

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
const usageProvider = computed(() => current.value?.adapter === 'claude-code'
  ? 'claude' as const
  : current.value?.adapter === 'codex' ? 'codex' as const : current.value ? 'opencode' as const : undefined)
const avatar = computed(() => assistant.value ? { src: assistant.value.avatar ?? undefined, alt: assistant.value.name } : undefined)

const handingOff = computed(() => !!assistant.value?.handoff)
const freshStartPending = ref(false)
const editing = ref(false)
const journalOpen = ref(false)

async function freshStart() {
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
            <span class="truncate">{{ assistant?.name ?? 'Assistant' }}</span>
          </span>
        </template>

        <template #trailing>
          <UBadge v-if="assistant?.archived" color="neutral" variant="subtle" size="sm" label="Archived" />
          <StatusDot v-if="current" :status="current.status" />
        </template>

        <template #right>
          <UsageMeter :usage="current?.usage ?? null" :provider="usageProvider" />
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
              @click="freshStart"
            />
          </UTooltip>
          <UTooltip :text="voiceOpen ? 'Close the voice bar' : `Talk to ${assistant?.name ?? 'it'}`">
            <UButton
              icon="i-lucide-mic"
              :color="voiceOpen ? 'primary' : 'neutral'"
              :variant="voiceOpen ? 'soft' : 'ghost'"
              :aria-label="voiceOpen ? 'Close the voice bar' : 'Talk to this assistant'"
              @click="voiceOpen = !voiceOpen"
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
        </template>
        <template #right>
          <USwitch v-model="condensed" size="xs" label="Condensed" :ui="{ label: 'text-xs text-muted' }" />
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div class="flex h-full min-h-0 flex-col">
        <ServiceBanner />
        <AgentUnstartableBanner v-if="current && blocked" :session="current" :reason="blocked" />
        <AgentErrorBanner v-else-if="current" :session="current" />

        <div v-if="earlier" class="flex shrink-0 justify-center pb-1">
          <UButton
            :label="`Show the session before (${earlier} earlier)`"
            icon="i-lucide-chevrons-up"
            color="neutral"
            variant="ghost"
            size="xs"
            @click="shown += 1"
          />
        </div>

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
          :condensed="condensed"
          :avatar="avatar"
        />

        <div v-if="pending.length && !blocked" class="mx-auto max-h-[40vh] w-full max-w-3xl shrink-0 space-y-2 overflow-y-auto border-t border-default py-2">
          <PermissionCard v-for="permission in pending" :key="permission.id" :permission="permission" />
        </div>

        <div v-if="queued.length && current" class="shrink-0 pt-2">
          <AgentInbox :agent-session-id="current.id" :messages="queued" :readonly="!!blocked" />
        </div>

        <div v-if="!blocked && voiceOpen && current" class="shrink-0 pt-2">
          <AgentVoiceBar :session="current" />
        </div>

        <div v-if="!blocked && current && !assistant?.archived" class="shrink-0 pt-2">
          <AgentComposer :session="current" />
        </div>
      </div>

      <AssistantModal v-model:open="editing" :assistant="assistant" />
      <AssistantJournal v-if="assistant" v-model:open="journalOpen" :assistant="assistant" :sessions="sessions" />
    </template>
  </UDashboardPanel>
</template>
