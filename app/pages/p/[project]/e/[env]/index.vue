<script setup lang="ts">
type Overview = Awaited<ReturnType<typeof apiClient.envs.overview.call>>

const route = useRoute()
const projectName = computed(() => route.params.project as string)
const envName = computed(() => route.params.env as string)

const { data: projects, refresh: refreshProjects } = await apiClient.projects.list.useCall()
const project = computed(() => projects.value?.find((p) => p.name === projectName.value) ?? null)

// Guarded — `envs.list` 400s on an empty projectId (not-found URL / before
// projects resolve), so only call once the project is known.
type EnvList = Awaited<ReturnType<typeof apiClient.envs.list.call>>
const envs = ref<EnvList>([])
async function refreshEnvs() {
  const pid = project.value?.id
  envs.value = pid ? await apiClient.envs.list.call({ projectId: pid }) : []
}
await refreshEnvs()
watch(() => project.value?.id, refreshEnvs)
const env = computed(() => envs.value?.find((e) => e.name === envName.value) ?? null)

const overview = ref<Overview | null>(null)
async function refreshOverview() {
  if (!env.value) { overview.value = null; return }
  overview.value = await apiClient.envs.overview.call({ id: env.value.id })
}
await refreshOverview()
watch(env, () => refreshOverview())

// Push-live refetch on row-shape writes. With Coast gone (step 3a), the
// live status overlay is folded into `envs.list` / `envs.overview`
// (both call `docker inspect` server-side) — `table-change` for `envs`
// triggers a refetch and we see the new state on the next snapshot.
useLiveRefresh(() => Promise.all([refreshOverview(), refreshEnvs(), refreshProjects()]), {
  tables: ['envs', 'projects'],
})

const busy = ref<null | 'stop' | 'start' | 'restart' | 'delete' | 'run'>(null)
const errMsg = ref<string | null>(null)
const router = useRouter()

async function action(kind: NonNullable<typeof busy.value>) {
  if (!env.value || !project.value) return
  busy.value = kind
  errMsg.value = null
  try {
    switch (kind) {
      case 'stop': await apiClient.envs.stop.call({ id: env.value.id }); break
      case 'start': await apiClient.envs.start.call({ id: env.value.id }); break
      case 'restart': await apiClient.envs.restart.call({ id: env.value.id }); break
      case 'run':
        // Re-run `devcontainer up` — used to (re-)provision after editing
        // devcontainer.json or after a container disappears.
        await fetch('/api/envs/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ envId: env.value.id }),
        })
        break
      case 'delete':
        if (!confirm(`Delete env "${env.value.name}"? The container and worktree will be removed.`)) {
          busy.value = null
          return
        }
        await apiClient.envs.delete.call({ id: env.value.id })
        await router.push(`/p/${project.value.name}`)
        return
    }
    await refreshOverview()
    await refreshEnvs()
  } catch (e) {
    errMsg.value = (e as Error).message
  } finally {
    busy.value = null
  }
}

function badgeColor(status: string | null | undefined): 'neutral' | 'success' | 'warning' | 'error' | 'primary' {
  if (!status) return 'neutral'
  switch (status) {
    case 'running': return 'success'
    case 'provisioning': case 'starting': return 'warning'
    case 'stopped': return 'neutral'
    case 'error': case 'missing': return 'error'
    default: return 'primary'
  }
}

function serviceUrl(port: number): string {
  return `${location.protocol}//${location.hostname}:${port}`
}
</script>

<template>
  <DomoEmptyState
    v-if="!project || !env"
    icon="i-lucide-compass"
    title="Environment not found"
    :description="`No environment “${envName}” in project “${projectName}”.`"
  >
    <UButton :to="`/p/${projectName}`" color="primary" icon="i-lucide-arrow-left">
      Back to project
    </UButton>
  </DomoEmptyState>

  <div v-else-if="overview" class="p-6 space-y-6 max-w-5xl">
    <header class="space-y-1">
      <h2 class="text-xl font-semibold flex items-center gap-2">
        {{ env.name }}
        <UBadge :color="badgeColor(overview.env.liveStatus ?? overview.env.status)" variant="subtle" size="sm">
          {{ overview.env.liveStatus ?? overview.env.status ?? 'unknown' }}
        </UBadge>
      </h2>
      <p class="text-sm text-muted">
        <span v-if="env.branch">branch <code>{{ env.branch }}</code> · </span>
        <span v-if="env.worktreePath">worktree <code>{{ env.worktreePath }}</code></span>
      </p>
      <p v-if="overview.daemonUnreachable" class="text-xs text-error">
        Docker daemon unreachable — showing cached data only.
      </p>
      <p v-else-if="overview.env.liveStatus === 'missing'" class="text-xs text-warning">
        No container for this env yet. Click <strong>Run / Up</strong> to provision.
      </p>

      <div class="flex flex-wrap gap-2 pt-2">
        <UButton size="xs" icon="i-lucide-square" variant="ghost" :loading="busy === 'stop'" :disabled="!!busy" @click="action('stop')">
          Stop
        </UButton>
        <UButton size="xs" icon="i-lucide-play" variant="ghost" :loading="busy === 'start'" :disabled="!!busy" @click="action('start')">
          Start
        </UButton>
        <UButton size="xs" icon="i-lucide-rotate-cw" variant="ghost" :loading="busy === 'restart'" :disabled="!!busy" @click="action('restart')">
          Restart
        </UButton>
        <UButton size="xs" icon="i-lucide-rocket" variant="ghost" :loading="busy === 'run'" :disabled="!!busy" @click="action('run')">
          Run / Up
        </UButton>
        <UButton size="xs" icon="i-lucide-trash-2" variant="ghost" color="error" :loading="busy === 'delete'" :disabled="!!busy" @click="action('delete')">
          Delete
        </UButton>
      </div>
      <UAlert
        v-if="errMsg"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="errMsg"
        close
        class="mt-2"
        @update:open="errMsg = null"
      />
    </header>

    <section v-if="overview.ports.length > 0">
      <h3 class="text-sm font-semibold mb-2">
        Ports
      </h3>
      <table class="w-full text-sm border border-default rounded overflow-hidden">
        <thead class="bg-elevated/50">
          <tr>
            <th class="text-left px-3 py-2 font-medium">
              Name
            </th>
            <th class="text-left px-3 py-2 font-medium">
              Container
            </th>
            <th class="text-left px-3 py-2 font-medium">
              Host
            </th>
            <th class="text-left px-3 py-2 font-medium">
              Open
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in overview.ports" :key="p.name + ':' + p.innerPort" class="border-t border-default">
            <td class="px-3 py-2">
              {{ p.name }}
              <span v-if="p.appProtocol" class="text-xs text-muted ml-1">({{ p.appProtocol }})</span>
            </td>
            <td class="px-3 py-2 font-mono text-xs">
              {{ p.innerPort }}/{{ p.protocol }}
            </td>
            <td class="px-3 py-2 font-mono text-xs">
              {{ p.hostPort ?? '—' }}
            </td>
            <td class="px-3 py-2">
              <a
                v-if="p.hostPort"
                :href="serviceUrl(p.hostPort)"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary hover:underline inline-flex items-center gap-1"
              >
                localhost:{{ p.hostPort }}
                <UIcon name="i-lucide-external-link" class="size-3" />
              </a>
              <span v-else class="text-muted text-xs">not running</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <h3 class="text-sm font-semibold mb-2">
        Worktree
      </h3>
      <p class="text-sm text-muted">
        <code>{{ env.worktreePath ?? '—' }}</code>
      </p>
      <p class="text-xs text-muted mt-1">
        Browse and edit files in the workspace panel's
        <strong>Files</strong> tab; the
        <NuxtLink
          :to="`/p/${projectName}/e/${envName}/terminal`"
          class="text-primary hover:underline"
        >
          <strong>Terminal</strong>
        </NuxtLink>
        view opens a shell inside this env's container.
      </p>
    </section>
  </div>

  <div v-else class="p-6 space-y-4 max-w-5xl">
    <USkeleton class="h-7 w-48" />
    <USkeleton class="h-4 w-80" />
    <div class="flex gap-2 pt-2">
      <USkeleton v-for="i in 5" :key="i" class="h-7 w-20" />
    </div>
    <USkeleton class="h-32 w-full" />
  </div>
</template>
