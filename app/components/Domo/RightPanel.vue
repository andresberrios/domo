<script setup lang="ts">
// Shared with app.vue's ⌘1/⌘2 shortcuts (see workspace:tab there).
const tab = useState<'files' | 'git'>('workspace:tab', () => 'files')
// Nuxt UI `UTabs` keys its v-model off each item's `value`.
const tabs = [
  { value: 'files', label: 'Files', icon: 'i-lucide-folder-tree' },
  { value: 'git', label: 'Git', icon: 'i-lucide-git-branch' },
]

const { envId, projectName, envName } = useSelectedEnv()
</script>

<template>
  <UDashboardToolbar>
    <template #left>
      <UTabs v-model="tab" :items="tabs" size="xs" variant="link" />
    </template>
  </UDashboardToolbar>

  <div
    v-if="!envId"
    class="flex-1 min-h-0 overflow-auto p-3 text-sm text-muted"
  >
    Select an environment to browse its worktree.
  </div>

  <div v-else class="flex-1 min-h-0 overflow-auto">
    <DomoFileTree
      v-show="tab === 'files'"
      :env-id="envId"
      :project-name="projectName!"
      :env-name="envName!"
      class="p-2"
    />
    <DomoGitChanges
      v-if="tab === 'git'"
      :env-id="envId"
      :project-name="projectName!"
      :env-name="envName!"
      class="h-full"
    />
  </div>
</template>
