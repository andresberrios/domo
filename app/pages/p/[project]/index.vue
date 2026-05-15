<script setup lang="ts">
const route = useRoute()
const projectName = computed(() => route.params.project as string)

const { data: projects } = await apiClient.projects.list.useCall()
const project = computed(() => projects.value?.find((p) => p.name === projectName.value) ?? null)

const envsCall = computed(() => project.value?.id ? { projectId: project.value.id } : null)
const { data: envs, refresh: refreshEnvs } = await apiClient.envs.list.useCall(envsCall.value as { projectId: string })
watch(() => project.value?.id, () => refreshEnvs())

const showAddEnv = useState('project:showAddEnv', () => false)
const showBuild = ref(false)

function badgeColor(status: string | null | undefined) {
  if (!status) return 'neutral'
  switch (status) {
    case 'running': case 'checked_out': return 'success'
    case 'provisioning': case 'starting': case 'stopping': case 'assigning': case 'unassigning': return 'warning'
    case 'stopped': case 'idle': case 'enqueued': return 'neutral'
    default: return 'primary'
  }
}
</script>

<template>
  <div v-if="!project" class="p-6 text-muted">
    Project <code>{{ projectName }}</code> not found.
  </div>

  <div v-else class="p-6 space-y-6 max-w-4xl">
    <header class="space-y-1">
      <h2 class="text-xl font-semibold flex items-center gap-2">
        {{ project.name }}
        <UTooltip v-if="!project.hasCoastfile" text="Missing Coastfile">
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
        <UButton size="xs" variant="ghost" icon="i-lucide-hammer" @click="showBuild = true">
          Rebuild
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
              <UIcon
                v-if="e.checkedOut"
                name="i-lucide-star"
                class="size-3.5 text-warning"
                title="Checked out"
              />
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
    />

    <UModal v-model:open="showBuild" title="Rebuild project" :ui="{ content: 'max-w-2xl' }">
      <template #body>
        <DomoBuildProgress
          v-if="showBuild"
          :project-id="project.id"
          @done="showBuild = false"
          @cancelled="showBuild = false"
        />
      </template>
    </UModal>
  </div>
</template>
