<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const toast = useToast()

const environmentId = computed(() => route.params.id as string)

const { environments, isReady } = useDevEnvironments()
const { projects } = useProjects()
const { sessions: agentSessions } = useAgentSessions()
const { pending } = usePermissions()

const environment = computed(() => environments.value.find(item => item.id === environmentId.value) ?? null)
const project = computed(() => projects.value.find(item => item.id === environment.value?.projectId) ?? null)
const agents = computed(() => agentSessions.value.filter(agent => agent.devEnvironmentId === environmentId.value))

const pendingByAgent = computed(() => {
  const map = new Map<string, number>()
  for (const permission of pending.value) {
    map.set(permission.agentSessionId, (map.get(permission.agentSessionId) ?? 0) + 1)
  }
  return map
})

const status = computed(() => ENVIRONMENT_STATUS_META[environment.value?.status ?? 'stopped'] ?? ENVIRONMENT_STATUS_META.stopped!)
const running = computed(() => environment.value?.status === 'running')

const busy = ref(false)
const newAgentOpen = ref(false)
const renaming = ref(false)
const confirmingDelete = ref(false)

async function action(path: 'start' | 'stop') {
  busy.value = true
  try {
    await $fetch(`/api/dev-environments/${environmentId.value}/${path}`, { method: 'POST' })
  } catch (error: any) {
    toast.add({ title: `Could not ${path} the environment`, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

async function rename(name: string) {
  renaming.value = false
  busy.value = true
  try {
    await $fetch(`/api/dev-environments/${environmentId.value}`, { method: 'PATCH', body: { name } })
  } catch (error: any) {
    toast.add({ title: 'Could not rename the environment', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

async function remove() {
  confirmingDelete.value = false
  busy.value = true
  try {
    await $fetch(`/api/dev-environments/${environmentId.value}`, { method: 'DELETE' })
    toast.add({ title: 'Environment deleted', color: 'neutral' })
    // The row this page renders is gone; there is nothing left to show here.
    await router.push(project.value ? `/projects/${project.value.id}` : '/')
  } catch (error: any) {
    toast.add({ title: 'Could not delete the environment', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

const exportOpen = ref(false)
</script>

<template>
  <UDashboardPanel id="environment">
    <template #header>
      <UDashboardNavbar icon="i-lucide-container">
        <template #title>
          <span class="truncate">{{ environment?.name ?? 'Environment' }}</span>
        </template>

        <template #trailing>
          <UBadge v-if="environment" :color="status.color" variant="subtle" size="sm" :label="status.label" />
        </template>

        <template #right>
          <UButton
            v-if="environment"
            label="New agent"
            icon="i-lucide-plus"
            size="sm"
            :ui="{ label: 'hidden sm:inline' }"
            @click="newAgentOpen = true"
          />
          <UButton
            v-if="environment"
            :label="running ? 'Stop' : 'Start'"
            :icon="running ? 'i-lucide-square' : 'i-lucide-play'"
            color="neutral"
            variant="subtle"
            size="sm"
            :loading="busy"
            :ui="{ label: 'hidden sm:inline' }"
            @click="action(running ? 'stop' : 'start')"
          />
          <UDropdownMenu
            v-if="environment"
            :items="[[
              { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming = true } },
              { label: 'Export branch', icon: 'i-lucide-git-branch', disabled: !running, onSelect: () => { exportOpen = true } }
            ], [
              { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { confirmingDelete = true } }
            ]]"
          >
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" aria-label="Environment actions" />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!environment" class="mx-auto w-full max-w-4xl py-8 text-center">
        <UIcon name="i-lucide-container" class="mx-auto size-8 text-dimmed" />
        <p class="mt-2 text-sm text-muted">
          {{ isReady ? 'This environment no longer exists.' : 'Loading…' }}
        </p>
      </div>

      <div v-else class="mx-auto w-full max-w-4xl space-y-6 py-4">
        <UAlert
          v-if="environment.lastError"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The last operation failed"
          :description="environment.lastError"
        />

        <section class="rounded-lg border border-default">
          <dl class="divide-y divide-default text-sm">
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Project</dt>
              <dd class="min-w-0 flex-1">
                <NuxtLink v-if="project" :to="`/projects/${project.id}`" class="inline-flex items-center gap-1.5 text-primary">
                  <UIcon name="i-lucide-folder-git-2" class="size-4" />
                  {{ project.name }}
                </NuxtLink>
                <span v-else class="text-dimmed">Unknown</span>
              </dd>
            </div>
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Status</dt>
              <dd class="flex min-w-0 flex-1 items-center gap-2">
                <EnvironmentIcon :status="environment.status" />
                <span>{{ status.label }}</span>
              </dd>
            </div>
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Workspace</dt>
              <dd class="min-w-0 flex-1 truncate font-mono text-xs">{{ environment.workspacePath }}</dd>
            </div>
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Container</dt>
              <dd class="min-w-0 flex-1 truncate font-mono text-xs">{{ environment.containerName }}</dd>
            </div>
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Configuration</dt>
              <dd class="min-w-0 flex-1">
                <UBadge color="neutral" variant="outline" size="sm" :label="environment.configPath || `${environment.configSource} config`" />
                <span class="ms-2 text-xs text-muted">
                  {{ environment.configSource === 'domo' ? 'From the project’s own .domo.json' : 'Domo’s built-in definition' }}
                </span>
              </dd>
            </div>
            <div v-if="environment.remoteUser" class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Remote user</dt>
              <dd class="min-w-0 flex-1 font-mono text-xs">{{ environment.remoteUser }}</dd>
            </div>
          </dl>
        </section>

        <section class="space-y-2">
          <h2 class="text-sm font-semibold">Ports</h2>
          <DevEnvironmentPorts :environment="environment" />
        </section>

        <section class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-semibold">Agents</h2>
            <UButton label="New agent here" icon="i-lucide-plus" color="neutral" variant="subtle" size="xs" @click="newAgentOpen = true" />
          </div>

          <ul v-if="agents.length" class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <li v-for="agent in agents" :key="agent.id">
              <NuxtLink :to="`/agents/${agent.id}`" class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-elevated">
                <AgentStatusIcon :status="agent.status" />
                <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                <UChip v-if="pendingByAgent.get(agent.id)" :text="pendingByAgent.get(agent.id)" color="warning" size="sm" standalone />
                <span class="text-xs text-dimmed">{{ relativeTime(agent.lastActivityAt ?? agent.createdAt) }}</span>
              </NuxtLink>
            </li>
          </ul>
          <p v-else class="rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
            No agents are running in this environment.
          </p>
        </section>

        <section class="flex flex-wrap gap-2">
          <OpenInVsCode :environment="environment" />
          <ExportBranchModal v-model:open="exportOpen" :environment="environment" />
        </section>
      </div>

      <NewAgentModal v-if="environment" v-model:open="newAgentOpen" :environment-id="environment.id" />

      <RenameModal
        v-if="environment"
        v-model:open="renaming"
        title="Rename environment"
        description="Changes the name shown in Domo. The container and its volume keep the names they were created with."
        :initial="environment.name"
        @submit="rename"
      />

      <ConfirmModal
        v-if="environment"
        v-model:open="confirmingDelete"
        :title="`Delete ${environment.name}?`"
        :description="`Stops and deletes the container, its checkout volume, any Docker-in-Docker volume, and ${agents.length === 1 ? 'the 1 coding agent session' : `all ${agents.length} coding agent sessions`} running inside it. Work that has not been pushed or exported is lost.`"
        confirm-label="Delete environment"
        :loading="busy"
        @confirm="remove"
      />
    </template>
  </UDashboardPanel>
</template>
