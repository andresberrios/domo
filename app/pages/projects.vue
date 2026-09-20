<script setup lang="ts">
import type { DevEnvironment, Project } from '~~/shared/types'

const toast = useToast()
const { projects } = useProjects()
const { environments } = useDevEnvironments()
const { sessions: agents } = useAgentSessions()

const projectName = ref('')
const repoPath = ref('')
const addingProject = ref(false)
const environmentNames = reactive<Record<string, string>>({})
const busy = reactive<Record<string, boolean>>({})

function environmentsFor(projectId: string) {
  return environments.value.filter(environment => environment.projectId === projectId)
}

function agentCount(environmentId: string) {
  return agents.value.filter(agent => agent.devEnvironmentId === environmentId).length
}

async function addProject() {
  if (!repoPath.value.trim()) return
  addingProject.value = true
  try {
    await $fetch('/api/projects', {
      method: 'POST',
      body: { name: projectName.value.trim() || undefined, repoPath: repoPath.value.trim() }
    })
    projectName.value = ''
    repoPath.value = ''
    toast.add({ title: 'Project added', color: 'success' })
  } catch (error: any) {
    toast.add({ title: 'Could not add project', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    addingProject.value = false
  }
}

async function createEnvironment(project: Project) {
  const name = environmentNames[project.id]?.trim()
  if (!name) return
  busy[project.id] = true
  try {
    await $fetch('/api/dev-environments', { method: 'POST', body: { projectId: project.id, name } })
    environmentNames[project.id] = ''
    toast.add({ title: `${name} is ready`, description: 'The repository was copied into its container.', color: 'success' })
  } catch (error: any) {
    toast.add({ title: 'Could not create environment', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy[project.id] = false
  }
}

async function environmentAction(environment: DevEnvironment, action: 'start' | 'stop') {
  busy[environment.id] = true
  try {
    await $fetch(`/api/dev-environments/${environment.id}/${action}`, { method: 'POST' })
  } catch (error: any) {
    toast.add({ title: `Could not ${action} environment`, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy[environment.id] = false
  }
}

async function deleteEnvironment(environment: DevEnvironment) {
  if (!confirm(`Delete ${environment.name}, its checkout, Compose stacks, and agent sessions? Work that is not pushed is lost.`)) return
  busy[environment.id] = true
  try {
    await $fetch(`/api/dev-environments/${environment.id}`, { method: 'DELETE' })
    toast.add({ title: `${environment.name} deleted`, color: 'neutral' })
  } finally {
    busy[environment.id] = false
  }
}

async function deleteProject(project: Project) {
  if (!confirm(`Delete ${project.name} and all its development environments?`)) return
  busy[project.id] = true
  try {
    await $fetch(`/api/projects/${project.id}`, { method: 'DELETE' })
    toast.add({ title: `${project.name} deleted`, color: 'neutral' })
  } finally {
    busy[project.id] = false
  }
}
</script>

<template>
  <UDashboardPanel id="projects">
    <template #header>
      <UDashboardNavbar title="Projects" icon="i-lucide-box" />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-4xl space-y-6 py-4">
        <UAlert
          icon="i-lucide-container"
          color="primary"
          variant="subtle"
          title="Isolated development environments"
          description="Each environment gets a private copy of its repository and a Docker-in-Docker daemon. Multiple coding agents can work together inside the same environment."
        />

        <section class="space-y-3 rounded-lg border border-default p-4">
          <div>
            <h2 class="text-sm font-semibold">Add project</h2>
            <p class="text-xs text-muted">Choose an existing local Git checkout as the source for environment copies.</p>
          </div>
          <div class="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
            <UFormField label="Name">
              <UInput v-model="projectName" placeholder="Domo" class="w-full" />
            </UFormField>
            <UFormField label="Repository">
              <DirectoryPicker v-model="repoPath" />
            </UFormField>
            <UButton label="Add project" icon="i-lucide-plus" :loading="addingProject" :disabled="!repoPath.trim()" @click="addProject" />
          </div>
        </section>

        <section v-if="!projects.length" class="rounded-lg border border-dashed border-default p-8 text-center">
          <UIcon name="i-lucide-folder-git-2" class="mx-auto size-8 text-dimmed" />
          <p class="mt-2 text-sm text-muted">Add a project to create its first isolated environment.</p>
        </section>

        <section v-for="project in projects" :key="project.id" class="overflow-hidden rounded-lg border border-default">
          <div class="flex items-start gap-3 border-b border-default p-4">
            <UIcon name="i-lucide-folder-git-2" class="mt-0.5 size-5 text-primary" />
            <div class="min-w-0 flex-1">
              <h2 class="text-sm font-semibold">{{ project.name }}</h2>
              <p class="truncate font-mono text-xs text-dimmed">{{ project.repoPath }}</p>
            </div>
            <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" :loading="busy[project.id]" @click="deleteProject(project)" />
          </div>

          <div class="space-y-3 p-4">
            <div v-if="environmentsFor(project.id).length" class="space-y-2">
              <div v-for="environment in environmentsFor(project.id)" :key="environment.id" class="rounded-md bg-elevated/50 p-3">
                <div class="flex items-center gap-3">
                  <StatusDot :status="environment.status === 'running' ? 'idle' : environment.status" />
                  <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="truncate text-sm font-medium">{{ environment.name }}</span>
                    <UBadge size="sm" color="neutral" variant="subtle" :label="`${agentCount(environment.id)} agents`" />
                    <UBadge size="sm" :color="environment.status === 'running' ? 'success' : environment.status === 'error' ? 'error' : 'neutral'" variant="subtle" :label="environment.status" />
                    <UBadge size="sm" color="neutral" variant="outline" :label="environment.configPath || `${environment.configSource} config`" />
                  </div>
                  <p class="mt-0.5 truncate font-mono text-xs text-dimmed">{{ environment.containerName }} · {{ environment.workspacePath }}</p>
                  <p v-if="environment.lastError" class="mt-1 text-xs text-error">{{ environment.lastError }}</p>
                  </div>
                  <UButton
                    v-if="environment.status === 'running'"
                    icon="i-lucide-square"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :loading="busy[environment.id]"
                    @click="environmentAction(environment, 'stop')"
                  />
                  <UButton
                    v-else
                    icon="i-lucide-play"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :loading="busy[environment.id]"
                    @click="environmentAction(environment, 'start')"
                  />
                  <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" @click="deleteEnvironment(environment)" />
                </div>
                <DevEnvironmentPorts :environment="environment" />
              </div>
            </div>

            <div class="flex gap-2">
              <UInput v-model="environmentNames[project.id]" class="flex-1" placeholder="feature-auth" @keyup.enter="createEnvironment(project)" />
              <UButton
                label="Create environment"
                icon="i-lucide-container"
                color="neutral"
                variant="subtle"
                :loading="busy[project.id]"
                :disabled="!environmentNames[project.id]?.trim()"
                @click="createEnvironment(project)"
              />
            </div>
          </div>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
