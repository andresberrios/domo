<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

const route = useRoute()
const router = useRouter()
const toast = useToast()

const agentId = computed(() => route.params.id as string)

const { sessions } = useAgentSessions()
const { environments } = useDevEnvironments()
const { events } = useAgentEvents(agentId)
const { permissions, pending } = usePermissions(agentId)

const { data: fetched, refresh } = await useFetch<AgentSession>(
  () => `/api/agents/${agentId.value}`,
  { lazy: true }
)

/** Live-synced row wins; the fetch is only there for the first paint. */
const session = computed<AgentSession | null>(
  () => sessions.value.find(item => item.id === agentId.value) ?? fetched.value ?? null
)
const environment = computed(() =>
  environments.value.find(item => item.id === session.value?.devEnvironmentId) ?? null
)

const renaming = ref(false)
const titleDraft = ref('')
const starting = ref(false)

const modeItems = computed(() =>
  (session.value?.modes ?? []).map(mode => ({
    id: mode.id,
    label: mode.name,
    value: mode.id,
    description: mode.description ?? undefined
  }))
)

const currentMode = computed({
  get: () => session.value?.modeId ?? 'default',
  set: async (value: string) => {
    try {
      await $fetch(`/api/agents/${agentId.value}/mode`, { method: 'POST', body: { modeId: value } })
    } catch (error: any) {
      toast.add({ title: 'Could not change mode', description: error?.message, color: 'error' })
    }
  }
})

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
  toast.add({ title: 'Agent archived', color: 'neutral' })
  await router.push('/')
}

async function remove() {
  await $fetch(`/api/agents/${agentId.value}`, { method: 'DELETE' })
  toast.add({ title: 'Agent deleted', color: 'neutral' })
  await router.push('/')
}

const menuItems = computed(() => [
  modeItems.value.length
    ? modeItems.value.map(mode => ({
        label: mode.label,
        icon: currentMode.value === mode.id ? 'i-lucide-check' : undefined,
        class: 'sm:hidden',
        onSelect: () => { currentMode.value = mode.id }
      }))
    : [],
  [
  { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { titleDraft.value = session.value?.title ?? ''; renaming.value = true } },
  { label: 'Restart adapter', icon: 'i-lucide-rotate-ccw', onSelect: start },
  { label: 'Archive', icon: 'i-lucide-archive', onSelect: archive },
  { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: remove }
]].filter(group => group.length))
</script>

<template>
  <UDashboardPanel id="agent">
    <template #header>
      <UDashboardNavbar icon="i-lucide-bot">
        <template #title>
          <span class="truncate">{{ session?.title ?? 'Agent' }}</span>
        </template>

        <template #trailing>
          <StatusDot v-if="session" :status="session.status" />
        </template>

        <template #right>
          <USelectMenu
            v-if="modeItems.length"
            v-model="currentMode"
            :items="modeItems"
            value-key="value"
            size="sm"
            class="hidden w-40 sm:block"
          />
          <UButton
            v-if="session && (session.status === 'stopped' || session.status === 'error')"
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
            color="primary"
            variant="subtle"
            size="sm"
            :label="environment.name"
          >
            <template #leading><UIcon name="i-lucide-container" class="size-3" /></template>
          </UBadge>
        </template>
        <template #right>
          <span class="text-xs text-dimmed">{{ relativeTime(session?.lastActivityAt) }}</span>
        </template>
      </UDashboardToolbar>
    </template>

    <template #body>
      <div class="flex h-full min-h-0 flex-col">
        <ServiceBanner />
        <UAlert
          v-if="session?.lastError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="'Adapter error'"
          :description="session.lastError"
          class="mb-3"
        />

        <div v-if="!events.length && session?.status !== 'thinking'" class="flex flex-1 items-center justify-center">
          <div class="max-w-sm text-center">
            <UIcon name="i-lucide-bot" class="mx-auto size-8 text-dimmed" />
            <p class="mt-3 text-sm font-medium">
              Nothing here yet
            </p>
            <p class="mt-1 text-sm text-muted">
              Send this agent a task below, or tell Domo out loud what you want it to do.
            </p>
          </div>
        </div>

        <AgentTranscript
          v-else-if="session"
          :session="session"
          :events="events"
          :permissions="permissions"
          class="min-h-0 flex-1"
        />

        <div v-if="pending.length" class="mx-auto w-full max-w-3xl shrink-0 space-y-2 py-2">
          <PermissionCard
            v-for="permission in pending"
            :key="permission.id"
            :permission="permission"
          />
        </div>

        <div class="shrink-0 pt-2">
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
    </template>
  </UDashboardPanel>
</template>
