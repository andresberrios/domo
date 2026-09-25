<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const toast = useToast()

const environmentId = computed(() => route.params.id as string)

// `all`, not the switch-filtered list: this page is where the badge on every
// session that ran here links to, so it has to render a retired environment
// whatever the sidebar is currently showing.
const { all: environments, isReady } = useDevEnvironments()
const { all: projects } = useProjects()
const { sessions: agentSessions, all: allAgents } = useAgentSessions()
const { pending } = usePermissions()

const environment = computed(() => environments.value.find(item => item.id === environmentId.value) ?? null)
const project = computed(() => projects.value.find(item => item.id === environment.value?.projectId) ?? null)
const retired = computed(() => !!environment.value?.retiredAt)
/**
 * Docker resources this environment still owns and should not. Normally empty;
 * when it is not, the "everything was destroyed" line above it is not the whole
 * truth, and gigabytes are the difference.
 */
const leftovers = computed(() => environment.value?.leftovers ?? [])
/**
 * Keyed on the **status**, never on `lastError`.
 *
 * The same rule as `AgentErrorBanner`, and for the same measured reason: a
 * banner keyed on the field outlives what it described, because `last_error` is
 * history and `status` is state. What the field is for is saying *what* is
 * wrong once the state says something is.
 */
const broken = computed(() => environment.value?.status === 'error')
const brokenTitle = computed(() => (
  leftovers.value.length ? 'Not everything could be removed' : 'This environment needs attention'
))
/** Only a cleanup can be retried from here; every other failure needs its own action. */
const brokenActions = computed(() => (leftovers.value.length
  ? [{ label: 'Try again', color: 'error' as const, variant: 'outline' as const, loading: busy.value, onClick: retryCleanup }]
  : undefined))
const agents = computed(() => agentSessions.value.filter(agent => agent.devEnvironmentId === environmentId.value))
/** Every session that ran here, archived ones included: this page is their record. */
const pastAgents = computed(() =>
  allAgents.value.filter(agent => agent.devEnvironmentId === environmentId.value)
)

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
const confirmingRetire = ref(false)

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

async function retireEnvironment() {
  confirmingRetire.value = false
  busy.value = true
  try {
    const result = await $fetch(`/api/dev-environments/${environmentId.value}`, { method: 'DELETE' })
    // Normally empty. When it is not, Docker refused to remove something and
    // that is gigabytes still on the disk. Nothing retries it in the background,
    // so the reason — which names what is in the way — has to be said here and
    // stay on the page.
    toast.add(result.leftovers.length
      ? {
          title: 'Environment retired, but not everything could be removed',
          description: result.leftovers[0]!.error,
          color: 'warning'
        }
      : { title: 'Environment retired', description: 'Its records stay readable.', color: 'neutral' })
    // The row is still here — it is the record — but the actions are not, so
    // the project is the more useful place to land.
    await router.push(project.value ? `/projects/${project.value.id}` : '/')
  } catch (error: any) {
    toast.add({ title: 'Could not retire the environment', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

/**
 * Ask again, once whatever the error named has been dealt with.
 *
 * There is no timer behind this on the server: a refused removal is refused for
 * a reason that does not clear on its own, so the button is the retry.
 */
async function retryCleanup() {
  busy.value = true
  try {
    const result = await $fetch(`/api/dev-environments/${environmentId.value}/cleanup`, { method: 'POST' })
    toast.add(result.leftovers.length
      ? { title: 'Still blocked', description: result.leftovers[0]!.error, color: 'warning' }
      : {
          title: 'Cleaned up',
          description: 'Nothing of this environment is left on the machine.',
          color: 'success'
        })
  } catch (error: any) {
    toast.add({ title: 'Could not run the cleanup', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

const exportOpen = ref(false)
const importOpen = ref(false)
</script>

<template>
  <UDashboardPanel id="environment">
    <template #header>
      <UDashboardNavbar icon="i-lucide-monitor">
        <template #title>
          <span class="truncate">{{ environment?.name ?? 'Environment' }}</span>
        </template>

        <template #trailing>
          <UBadge v-if="retired" color="neutral" variant="subtle" size="sm" label="Retired" />
          <UBadge v-else-if="environment" :color="status.color" variant="subtle" size="sm" :label="status.label" />
        </template>

        <template #right>
          <UButton
            v-if="environment && !retired"
            label="New agent"
            icon="i-lucide-plus"
            size="sm"
            :ui="{ label: 'hidden sm:inline' }"
            @click="newAgentOpen = true"
          />
          <UButton
            v-if="environment && !retired"
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
            v-if="environment && !retired"
            :items="[[
              { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming = true } },
              { label: 'Export branch', icon: 'i-lucide-git-branch', disabled: !running, onSelect: () => { exportOpen = true } },
              { label: 'Import branch', icon: 'i-lucide-git-branch-plus', disabled: !running, onSelect: () => { importOpen = true } }
            ], [
              { label: 'Retire', icon: 'i-lucide-box', color: 'error' as const, onSelect: () => { confirmingRetire = true } }
            ]]"
          >
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" aria-label="Environment actions" />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!environment" class="mx-auto w-full max-w-4xl py-8 text-center">
        <UIcon name="i-lucide-monitor" class="mx-auto size-8 text-dimmed" />
        <p class="mt-2 text-sm text-muted">
          {{ isReady ? 'This environment no longer exists.' : 'Loading…' }}
        </p>
      </div>

      <div v-else class="mx-auto w-full max-w-4xl space-y-6 py-4">
        <UAlert
          v-if="retired"
          color="neutral"
          variant="subtle"
          icon="i-lucide-archive"
          title="Retired"
          :description="`The container, its copy of the checkout and its image were destroyed ${relativeTime(environment.retiredAt)}. This page is the record of it: the sessions that ran here are still readable and can no longer be started. Nothing about the environment itself can be restored.`"
        />

        <UAlert
          v-if="broken"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="brokenTitle"
          :description="environment.lastError ?? 'Something about this environment needs looking at.'"
          :actions="brokenActions"
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

        <section v-if="!retired" class="space-y-2">
          <h2 class="text-sm font-semibold">Ports</h2>
          <DevEnvironmentPorts :environment="environment" />
        </section>

        <section v-if="!retired" class="space-y-2">
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

        <section v-if="retired && pastAgents.length" class="space-y-2">
          <h2 class="text-sm font-semibold">Agents that ran here</h2>
          <ul class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <li v-for="agent in pastAgents" :key="agent.id">
              <NuxtLink :to="`/agents/${agent.id}`" class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-elevated">
                <UIcon name="i-lucide-box" class="size-4 shrink-0 text-dimmed" />
                <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                <UBadge v-if="agent.archived" size="sm" color="neutral" variant="subtle" label="archived" />
                <span class="text-xs text-dimmed">{{ relativeTime(agent.lastActivityAt ?? agent.createdAt) }}</span>
              </NuxtLink>
            </li>
          </ul>
        </section>

        <section v-if="!retired" class="flex flex-wrap gap-2">
          <OpenInVsCode :environment="environment" />
          <ExportBranchModal v-model:open="exportOpen" :environment="environment" />
          <ImportBranchModal v-model:open="importOpen" :environment="environment" />
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
        v-model:open="confirmingRetire"
        :title="`Retire ${environment.name}?`"
        :description="`Destroys the container, its copy of the checkout and any Docker-in-Docker volume. ${agents.length === 1 ? 'The 1 coding agent session' : `All ${agents.length} coding agent sessions`} inside it stay readable and can never be started again, and work that has not been pushed or exported is lost.`"
        confirm-label="Retire environment"
        :loading="busy"
        @confirm="retireEnvironment"
      />
    </template>
  </UDashboardPanel>
</template>
