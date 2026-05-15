<script setup lang="ts">
const tab = ref<'files' | 'git'>('files')

const tabs = [
  { id: 'files', label: 'Files', icon: 'i-lucide-folder-tree' },
  { id: 'git', label: 'Git', icon: 'i-lucide-git-branch' },
]
</script>

<template>
  <UDashboardToolbar>
    <template #left>
      <UTabs v-model="tab" :items="tabs" size="xs" variant="link" />
    </template>
  </UDashboardToolbar>

  <div class="flex-1 min-h-0 overflow-auto p-3 text-sm text-muted">
    <template v-if="tab === 'files'">
      File tree — wired in Phase 2 via coastd `/files/tree`.
    </template>
    <template v-else>
      Git changes — wired in Phase 2 against the worktree on the host.
    </template>
  </div>
</template>
