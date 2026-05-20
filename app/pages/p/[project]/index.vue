<script setup lang="ts">
const route = useRoute()
const projectName = computed(() => route.params.project as string)

const { data: projects } = await apiClient.projects.list.useCall()
const project = computed(() => projects.value?.find((p) => p.name === projectName.value) ?? null)

// Guarded fetch — `envs.list` rejects an empty projectId with a 400, so
// don't call it until the project resolves (e.g. on a not-found URL).
type EnvList = Awaited<ReturnType<typeof apiClient.envs.list.call>>
const envs = ref<EnvList>([])
async function refreshEnvs() {
  const pid = project.value?.id
  envs.value = pid ? await apiClient.envs.list.call({ projectId: pid }) : []
}
await refreshEnvs()
watch(() => project.value?.id, refreshEnvs)

// Refetch envs on any envs-table write (coarse change-bus). Projects
// list is already reactive through its own `useCall`-driven cache;
// the listening composable below covers row-shape writes to envs only.
useLiveRefresh(() => refreshEnvs(), { tables: ['envs'] })

const showAddEnv = useState('project:showAddEnv', () => false)

function badgeColor(status: string | null | undefined) {
  if (!status) return 'neutral'
  switch (status) {
    case 'running': return 'success'
    case 'provisioning': case 'starting': return 'warning'
    case 'stopped': return 'neutral'
    case 'error': case 'missing': return 'error'
    default: return 'primary'
  }
}
</script>

<template>
  <DomoEmptyState
    v-if="!project"
    icon="i-lucide-compass"
    title="Project not found"
    :description="`No project named “${projectName}”. It may have been removed.`"
  >
    <UButton to="/" color="primary" icon="i-lucide-home">
      Back home
    </UButton>
  </DomoEmptyState>

  <div v-else class="p-6 space-y-6 max-w-4xl">
    <header class="space-y-1">
      <h2 class="text-xl font-semibold flex items-center gap-2">
        {{ project.name }}
        <UTooltip v-if="!project.hasDevcontainer" text="Missing devcontainer.json">
          <UIcon name="i-lucide-triangle-alert" class="size-4 text-warning" />
        </UTooltip>
      </h2>
      <p class="text-sm text-muted">
        <code>{{ project.rootPath }}</code>
        <span v-if="project.defaultBranch"> · default branch <code>{{ project.defaultBranch }}</code></span>
      </p>
      <div class="flex gap-2 pt-2">
        <UButton size="xs" color="primary" icon="i-lucide-plus" @click="showAddEnv = true">
          Env
        </UButton>
      </div>
    </header>

    <section>
      <h3 class="text-sm font-semibold mb-2">
        Environments
      </h3>
      <div v-if="!envs || envs.length === 0" class="text-sm text-muted border border-dashed border-default rounded p-4">
        No environments yet. Create one with <strong>+ Env</strong>.
      </div>
      <ul v-else class="border border-default rounded divide-y divide-default">
        <li v-for="e in envs" :key="e.id">
          <NuxtLink
            :to="`/p/${project.name}/e/${e.name}`"
            class="flex items-center justify-between px-3 py-2 hover:bg-elevated"
          >
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-box" class="size-4 text-muted" />
              <span class="font-medium">{{ e.name }}</span>
              <span v-if="e.branch" class="text-xs text-muted">on <code>{{ e.branch }}</code></span>
            </div>
            <div class="flex items-center gap-2">
              <UBadge :color="badgeColor(e.liveStatus ?? e.status)" variant="subtle" size="xs">
                {{ e.liveStatus ?? e.status ?? 'unknown' }}
              </UBadge>
            </div>
          </NuxtLink>
        </li>
      </ul>
    </section>

    <DomoAddEnvModal
      v-model:open="showAddEnv"
      :project-id="project.id"
      :default-branch="project.defaultBranch"
      @created="refreshEnvs()"
      @cancelled="refreshEnvs()"
    />
  </div>
</template>
