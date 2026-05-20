<script setup lang="ts">
/**
 * Lazy, `.gitignore`-aware file tree for the selected env's worktree.
 * Only the root level is fetched here; each `DomoFileTreeNode` fetches its
 * own children on expand, so large repos never get walked up front.
 */
type Tree = Awaited<ReturnType<typeof apiClient.workspace.tree.call>>

const props = defineProps<{
  envId: string
  projectName: string
  envName: string
}>()

const root = ref<Tree['entries']>([])
const error = ref<string | null>(null)
const loading = ref(false)

async function load() {
  loading.value = true
  error.value = null
  try {
    const res = await apiClient.workspace.tree.call({ envId: props.envId })
    root.value = res.entries
  } catch (e) {
    error.value = (e as Error).message
    root.value = []
  } finally {
    loading.value = false
  }
}

watch(() => props.envId, load, { immediate: true })

// Coast's `project.git_changed` push event went away with step 3a. The
// workspace tree no longer auto-refreshes on agent edits; users hit the
// refresh control or the parent calls `refresh()`. A host-side file
// watcher is a follow-up (step 4+).

defineExpose({ refresh: load })
</script>

<template>
  <div class="text-sm">
    <div v-if="loading && root.length === 0" class="px-2 py-1 text-muted">
      Loading…
    </div>
    <div v-else-if="error" class="px-2 py-1 text-error text-xs">
      {{ error }}
    </div>
    <div v-else-if="root.length === 0" class="px-2 py-1 text-muted">
      Empty worktree.
    </div>
    <ul v-else>
      <DomoFileTreeNode
        v-for="entry in root"
        :key="entry.path"
        :entry="entry"
        :env-id="envId"
        :project-name="projectName"
        :env-name="envName"
        :depth="0"
      />
    </ul>
  </div>
</template>
