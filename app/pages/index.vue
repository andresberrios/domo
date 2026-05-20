<script setup lang="ts">
/**
 * Landing surface. First run (no projects) → onboarding with an "Add a
 * project" CTA (opens the same AddProjectModal the left rail owns, via the
 * shared `leftRail:showAddProject` state). Otherwise → a picker grid of
 * projects so the center area isn't empty before one is selected.
 */
const { data: projects } = await apiClient.projects.list.useCall()
const showAddProject = useState('leftRail:showAddProject', () => false)
const hasProjects = computed(() => (projects.value?.length ?? 0) > 0)
</script>

<template>
  <DomoEmptyState
    v-if="!hasProjects"
    icon="i-lucide-folder-git-2"
    title="Welcome to Domo"
    description="Run parallel Claude Code agents over Coast environments. Add a project (a git repo with a Coastfile) to get started."
  >
    <UButton
      color="primary"
      icon="i-lucide-plus"
      @click="showAddProject = true"
    >
      Add a project
    </UButton>
  </DomoEmptyState>

  <div v-else class="p-8 max-w-4xl mx-auto">
    <h1 class="text-xl font-semibold">
      Projects
    </h1>
    <p class="mt-1 text-sm text-muted">
      Pick a project to view its environments, or open one from the left rail.
    </p>
    <ul class="mt-6 grid gap-3 sm:grid-cols-2">
      <li v-for="p in projects" :key="p.id">
        <NuxtLink
          :to="`/p/${p.name}`"
          class="flex items-start gap-3 rounded-lg border border-default p-4 hover:bg-elevated transition-colors"
        >
          <UIcon
            name="i-lucide-folder-git-2"
            class="size-5 shrink-0 text-muted mt-0.5"
          />
          <div class="min-w-0">
            <div class="font-medium truncate flex items-center gap-1.5">
              {{ p.name }}
              <UTooltip v-if="!p.hasDevcontainer" text="Missing devcontainer.json">
                <UIcon
                  name="i-lucide-triangle-alert"
                  class="size-3.5 text-warning"
                />
              </UTooltip>
            </div>
            <div class="text-xs text-muted truncate font-mono">
              {{ p.rootPath }}
            </div>
          </div>
        </NuxtLink>
      </li>
    </ul>
    <UButton
      class="mt-6"
      size="sm"
      variant="ghost"
      icon="i-lucide-plus"
      @click="showAddProject = true"
    >
      Add another project
    </UButton>
  </div>
</template>
