<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const toast = useToast()

const projectId = computed(() => route.params.id as string)

const { projects, isReady } = useProjects()
const { environments } = useDevEnvironments()
const { sessions: agentSessions } = useAgentSessions()
const { pending } = usePermissions()

const project = computed(() => projects.value.find(item => item.id === projectId.value) ?? null)
const projectEnvironments = computed(() => environments.value.filter(item => item.projectId === projectId.value))

// A local-directory agent has no dev environment, but its cwd may still sit
// inside this project's own checkout — the same attribution the tree makes.
function isUnderRepo(cwd: string, repoPath: string): boolean {
  const c = cwd.replace(/\/+$/, '')
  const r = repoPath.replace(/\/+$/, '')
  return c === r || c.startsWith(`${r}/`)
}

const localAgents = computed(() => {
  const repoPath = project.value?.repoPath
  if (!repoPath) return []
  return agentSessions.value.filter(agent => !agent.devEnvironmentId && isUnderRepo(agent.cwd, repoPath))
})

const environmentAgentCount = computed(() =>
  projectEnvironments.value.reduce(
    (sum, environment) => sum + agentSessions.value.filter(agent => agent.devEnvironmentId === environment.id).length,
    0
  )
)

function agentsIn(environmentId: string) {
  return agentSessions.value.filter(agent => agent.devEnvironmentId === environmentId).length
}

const pendingByAgent = computed(() => {
  const map = new Map<string, number>()
  for (const permission of pending.value) {
    map.set(permission.agentSessionId, (map.get(permission.agentSessionId) ?? 0) + 1)
  }
  return map
})

/** Whichever config the environments were built from — the project's own, or Domo's. */
const configSource = computed(() => {
  const sources = new Set(projectEnvironments.value.map(environment => environment.configSource))
  if (sources.has('domo') && sources.size === 1) return 'The project’s own .domo.json'
  if (sources.has('default') && sources.size === 1) return 'Domo’s built-in definition'
  if (!sources.size) return 'Read from .domo.json when the first environment is created'
  return 'Mixed — see each environment'
})

const busy = ref(false)
const newEnvironmentOpen = ref(false)
const renaming = ref(false)
const confirmingDelete = ref(false)

async function rename(name: string) {
  renaming.value = false
  busy.value = true
  try {
    await $fetch(`/api/projects/${projectId.value}`, { method: 'PATCH', body: { name } })
  } catch (error: any) {
    toast.add({ title: 'Could not rename the project', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

async function remove() {
  confirmingDelete.value = false
  busy.value = true
  try {
    await $fetch(`/api/projects/${projectId.value}`, { method: 'DELETE' })
    toast.add({ title: 'Project deleted', color: 'neutral' })
    await router.push('/')
  } catch (error: any) {
    toast.add({ title: 'Could not delete the project', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

const cascade = computed(() => {
  const count = projectEnvironments.value.length
  const environmentsText = count === 1 ? '1 development environment' : `${count} development environments`
  const agents = environmentAgentCount.value
  const agentsText = agents === 1 ? '1 coding agent session' : `${agents} coding agent sessions`
  return `Deletes ${environmentsText}, including each container, its checkout volume and any Docker-in-Docker volume. `
    + `${agentsText} inside them are retired rather than deleted, so their transcripts stay readable, but they can never be revived. `
    + `The checkout at ${project.value?.repoPath} is left on disk; anything that only exists inside an environment is lost.`
})
</script>

<template>
  <UDashboardPanel id="project">
    <template #header>
      <UDashboardNavbar icon="i-lucide-folder-git-2">
        <template #title>
          <span class="truncate">{{ project?.name ?? 'Project' }}</span>
        </template>

        <template #right>
          <UButton
            v-if="project"
            label="New environment"
            icon="i-lucide-plus"
            size="sm"
            :ui="{ label: 'hidden sm:inline' }"
            @click="newEnvironmentOpen = true"
          />
          <UDropdownMenu
            v-if="project"
            :items="[[
              { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming = true } }
            ], [
              { label: 'Delete', icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { confirmingDelete = true } }
            ]]"
          >
            <UButton icon="i-lucide-ellipsis-vertical" color="neutral" variant="ghost" aria-label="Project actions" />
          </UDropdownMenu>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div v-if="!project" class="mx-auto w-full max-w-4xl py-8 text-center">
        <UIcon name="i-lucide-folder-git-2" class="mx-auto size-8 text-dimmed" />
        <p class="mt-2 text-sm text-muted">
          {{ isReady ? 'This project no longer exists.' : 'Loading…' }}
        </p>
      </div>

      <div v-else class="mx-auto w-full max-w-4xl space-y-6 py-4">
        <section class="rounded-lg border border-default">
          <dl class="divide-y divide-default text-sm">
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Name</dt>
              <dd class="min-w-0 flex-1">{{ project.name }}</dd>
            </div>
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Repository</dt>
              <dd class="min-w-0 flex-1 truncate font-mono text-xs">{{ project.repoPath }}</dd>
            </div>
            <div class="flex gap-4 px-4 py-2.5">
              <dt class="w-32 shrink-0 text-muted">Configuration</dt>
              <dd class="min-w-0 flex-1">{{ configSource }}</dd>
            </div>
          </dl>
        </section>

        <section class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-semibold">Development environments</h2>
            <UButton label="New environment" icon="i-lucide-plus" color="neutral" variant="subtle" size="xs" @click="newEnvironmentOpen = true" />
          </div>

          <ul v-if="projectEnvironments.length" class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <li v-for="environment in projectEnvironments" :key="environment.id">
              <NuxtLink :to="`/environments/${environment.id}`" class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-elevated">
                <EnvironmentIcon :status="environment.status" />
                <span class="min-w-0 flex-1 truncate">{{ environment.name }}</span>
                <UBadge
                  size="sm"
                  color="neutral"
                  variant="subtle"
                  :label="agentsIn(environment.id) === 1 ? '1 agent' : `${agentsIn(environment.id)} agents`"
                />
                <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-dimmed" />
              </NuxtLink>
            </li>
          </ul>
          <p v-else class="rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
            No environments yet. Each one is a container with a private copy of this checkout.
          </p>
        </section>

        <section class="space-y-2">
          <h2 class="text-sm font-semibold">Agents in the local checkout</h2>

          <ul v-if="localAgents.length" class="divide-y divide-default overflow-hidden rounded-lg border border-default">
            <li v-for="agent in localAgents" :key="agent.id">
              <NuxtLink :to="`/agents/${agent.id}`" class="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-elevated">
                <AgentStatusIcon :status="agent.status" />
                <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                <UChip v-if="pendingByAgent.get(agent.id)" :text="pendingByAgent.get(agent.id)" color="warning" size="sm" standalone />
                <span class="text-xs text-dimmed">{{ relativeTime(agent.lastActivityAt ?? agent.createdAt) }}</span>
              </NuxtLink>
            </li>
          </ul>
          <p v-else class="rounded-lg border border-dashed border-default px-4 py-6 text-center text-sm text-muted">
            Nothing is running directly in {{ project.repoPath }}.
          </p>
        </section>
      </div>

      <NewEnvironmentModal v-model:open="newEnvironmentOpen" :project="project" />

      <RenameModal
        v-if="project"
        v-model:open="renaming"
        title="Rename project"
        description="Changes the name shown in Domo. The checkout on disk is not touched."
        :initial="project.name"
        @submit="rename"
      />

      <ConfirmModal
        v-if="project"
        v-model:open="confirmingDelete"
        :title="`Delete ${project.name}?`"
        :description="cascade"
        confirm-label="Delete project"
        :loading="busy"
        @confirm="remove"
      />
    </template>
  </UDashboardPanel>
</template>
