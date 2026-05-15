<script setup lang="ts">
import type { CoastEvent } from '~~/server/lib/coast/types'

const { data: projects, refresh: refreshProjects } = await apiClient.projects.list.useCall()

const expanded = useState<Set<string>>('leftRail:expanded', () => new Set())
const showDone = useState('leftRail:showDone', () => false)

const showAddProject = useState('leftRail:showAddProject', () => false)

function isExpanded(id: string): boolean {
  return expanded.value.has(id)
}
function toggle(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

useCoastEvents((e: CoastEvent) => {
  // Any coast lifecycle event invalidates the env list. We coarsely
  // refresh; future refinement can scope to the affected project/env.
  if (e.event.startsWith('instance.') || e.event.startsWith('service.') || e.event.startsWith('build.')) {
    refreshProjects()
    // Also bump the env-tree subnode keys so they re-fetch.
    envRefreshTick.value++
  }
})

// Bumping this counter triggers DomoLeftRailEnvList children to refetch.
const envRefreshTick = useState('leftRail:envRefreshTick', () => 0)
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto px-2 py-2 text-sm">
    <div v-if="!projects || projects.length === 0" class="px-2">
      <p class="text-muted">
        No projects yet.
      </p>
      <UButton
        size="xs"
        class="mt-2"
        color="primary"
        icon="i-lucide-plus"
        @click="showAddProject = true"
      >
        Add a project
      </UButton>
    </div>

    <ul v-else class="space-y-0.5">
      <li v-for="p in projects" :key="p.id">
        <div
          class="group flex items-center gap-1 rounded px-1 py-1 hover:bg-elevated cursor-pointer"
          @click="toggle(p.id)"
        >
          <UIcon
            :name="isExpanded(p.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-3 text-muted shrink-0"
          />
          <span class="font-medium truncate">{{ p.name }}</span>
          <UTooltip v-if="!p.hasCoastfile" text="Missing Coastfile">
            <UIcon name="i-lucide-triangle-alert" class="size-3 text-warning shrink-0 ml-auto" />
          </UTooltip>
        </div>

        <DomoLeftRailEnvList
          v-if="isExpanded(p.id)"
          :project-id="p.id"
          :project-name="p.name"
          :refresh-key="envRefreshTick"
          :show-done="showDone"
        />
      </li>
    </ul>

    <DomoAddProjectModal
      v-model:open="showAddProject"
      @added="refreshProjects()"
    />
  </div>
</template>
