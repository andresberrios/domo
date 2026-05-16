<script setup lang="ts">
const props = defineProps<{
  projectId: string
  projectName: string
  /** Bumped by parent to force re-fetch on coast events. */
  refreshKey: number
  showDone: boolean
}>()

// useCall keys by serialized input — bumping `refreshKey` invalidates the
// cache and re-runs the fetch. We also call refresh() in a watcher.
const { data: envs, refresh } = await apiClient.envs.list.useCall({ projectId: props.projectId })
watch(() => props.refreshKey, () => { refresh() })

function badgeColor(status: string | null | undefined): 'neutral' | 'success' | 'warning' | 'error' | 'primary' {
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
  <ul class="pl-4 space-y-0.5 mt-0.5">
    <li v-if="!envs || envs.length === 0" class="px-1 py-0.5 text-xs text-muted">
      No envs yet
    </li>
    <li v-for="e in envs" :key="e.id">
      <NuxtLink
        :to="`/p/${projectName}/e/${e.name}`"
        class="flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-elevated"
        active-class="bg-accented font-medium"
      >
        <UIcon name="i-lucide-box" class="size-3 text-muted shrink-0" />
        <span class="truncate">{{ e.name }}</span>
        <UBadge
          :color="badgeColor(e.liveStatus ?? e.status)"
          variant="subtle"
          size="xs"
          class="ml-auto"
        >
          {{ e.liveStatus ?? e.status ?? 'unknown' }}
        </UBadge>
        <UIcon
          v-if="e.checkedOut"
          name="i-lucide-star"
          class="size-3 text-warning shrink-0"
          title="Checked out (canonical ports)"
        />
      </NuxtLink>

      <DomoLeftRailSessionList
        :project-name="projectName"
        :env-name="e.name"
        :env-id="e.id"
        :show-done="showDone"
        :refresh-key="refreshKey"
      />
    </li>
  </ul>
</template>
