<script setup lang="ts">
import type { CoastEvent } from '~~/server/lib/coast/types'

const { data: projects, refresh: refreshProjects } = await apiClient.projects.list.useCall()

// `projects.list` follows the `projects` table on the coarse change bus
// (a project add/delete fires `{table:'projects'}`). Coast doesn't touch
// this row, so coast events aren't needed here.
useLiveRefresh(() => refreshProjects(), { tables: ['projects'] })

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
function expand(id: string): void {
  if (expanded.value.has(id)) return
  const next = new Set(expanded.value)
  next.add(id)
  expanded.value = next
}

// Coast events still drive the env liveStatus badge (the field comes from
// `coast ls`, not from our `envs` row), so we keep the coast subscription
// until step 3 swaps Coast out for devcontainers. The coarse table-change
// bus handles row-shape changes (insert/delete/status persisted to SQLite);
// coast events add the live runtime status overlay.
useCoastEvents((e: CoastEvent) => {
  if (e.event.startsWith('instance.') || e.event.startsWith('service.') || e.event.startsWith('build.')) {
    envRefreshTick.value++
  }
})

// Bumping this counter triggers DomoLeftRailEnvList children to refetch
// (coast-event overlay only — the table-change channel is wired directly
// in each child via `useLiveRefresh`).
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
        <div class="group flex items-center gap-1 rounded px-1 py-1 hover:bg-elevated">
          <UIcon
            :name="isExpanded(p.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-3 text-muted shrink-0 cursor-pointer hover:text-default"
            @click="toggle(p.id)"
          />
          <NuxtLink
            :to="`/p/${p.name}`"
            class="flex items-center gap-1 flex-1 min-w-0"
            active-class="text-primary"
            @click="expand(p.id)"
          >
            <span class="font-medium truncate">{{ p.name }}</span>
            <UTooltip v-if="!p.hasCoastfile" text="Missing Coastfile">
              <UIcon name="i-lucide-triangle-alert" class="size-3 text-warning shrink-0 ml-auto" />
            </UTooltip>
          </NuxtLink>
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
