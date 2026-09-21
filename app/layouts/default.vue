<script setup lang="ts">
import type { Project } from '~~/shared/types'

const { sessions: voiceSessions } = useVoiceSessions()
const { sessions: agentSessions } = useAgentSessions()
const { projects } = useProjects()
const { environments } = useDevEnvironments()
const { pending } = usePermissions()
const { creating, startConversation } = useNewConversation()

const newAgentOpen = ref(false)

const pendingByAgent = computed(() => {
  const map = new Map<string, number>()
  for (const permission of pending.value) {
    map.set(permission.agentSessionId, (map.get(permission.agentSessionId) ?? 0) + 1)
  }
  return map
})

function environmentsFor(projectId: string) {
  return environments.value.filter(environment => environment.projectId === projectId)
}

function agentsFor(environmentId: string) {
  return agentSessions.value.filter(agent => agent.devEnvironmentId === environmentId)
}

// A local-directory agent has no dev environment, but its cwd may still sit
// inside a project's own checkout — attribute it to that project rather than
// only ever showing it in the catch-all bucket.
function isUnderRepo(cwd: string, repoPath: string): boolean {
  const c = cwd.replace(/\/+$/, '')
  const r = repoPath.replace(/\/+$/, '')
  return c === r || c.startsWith(`${r}/`)
}

function localAgentsFor(project: Project) {
  return agentSessions.value.filter(agent => !agent.devEnvironmentId && isUnderRepo(agent.cwd, project.repoPath))
}

function projectAgentCount(project: Project) {
  return localAgentsFor(project).length
    + environmentsFor(project.id).reduce((sum, environment) => sum + agentsFor(environment.id).length, 0)
}

const attributedLocalAgentIds = computed(() => {
  const ids = new Set<string>()
  for (const project of projects.value) {
    for (const agent of localAgentsFor(project)) ids.add(agent.id)
  }
  return ids
})

// Sessions with no dev environment that also don't match any known project's
// checkout — legacy sessions and ad-hoc directories both land here.
const localAgents = computed(() =>
  agentSessions.value.filter(agent => !agent.devEnvironmentId && !attributedLocalAgentIds.value.has(agent.id))
)
</script>

<template>
  <UDashboardGroup>
    <UDashboardSidebar
      id="domo-sidebar"
      mode="slideover"
      resizable
      collapsible
      :default-size="18"
      :min-size="14"
      :max-size="28"
      :ui="{ footer: 'border-t border-default' }"
    >
      <template #header="{ collapsed }">
        <NuxtLink to="/" class="flex items-center gap-2 px-1 py-0.5">
          <span class="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <UIcon name="i-lucide-audio-lines" class="size-4" />
          </span>
          <span v-if="!collapsed" class="text-sm font-semibold tracking-tight">Domo</span>
        </NuxtLink>
      </template>

      <template #default="{ collapsed }">
        <div v-if="!collapsed" class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <UButton
              label="New conversation"
              icon="i-lucide-mic"
              block
              :loading="creating"
              @click="startConversation"
            />
            <UButton
              to="/projects"
              label="Projects"
              icon="i-lucide-box"
              color="neutral"
              variant="ghost"
              block
              class="justify-start"
            />
            <UButton
              label="New coding agent"
              icon="i-lucide-plus"
              color="neutral"
              variant="subtle"
              block
              @click="newAgentOpen = true"
            />
          </div>

          <div v-if="projects.length">
            <p class="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              Projects
            </p>
            <ul class="space-y-0.5">
              <li v-for="project in projects" :key="project.id">
                <UCollapsible default-open>
                  <template #default="{ open }">
                    <button
                      type="button"
                      class="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                    >
                      <UIcon
                        name="i-lucide-chevron-right"
                        class="size-3.5 shrink-0 text-dimmed transition-transform"
                        :class="{ 'rotate-90': open }"
                      />
                      <UIcon name="i-lucide-folder-git-2" class="size-4 shrink-0 text-primary" />
                      <span class="min-w-0 flex-1 truncate text-left font-medium">{{ project.name }}</span>
                      <UBadge
                        v-if="projectAgentCount(project)"
                        size="sm"
                        color="neutral"
                        variant="subtle"
                        :label="projectAgentCount(project)"
                      />
                    </button>
                  </template>

                  <template #content>
                    <ul class="mt-0.5 space-y-0.5 border-l border-default pl-3">
                      <li v-if="localAgentsFor(project).length">
                        <p class="px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-dimmed">
                          Local
                        </p>
                        <ul class="space-y-0.5">
                          <li v-for="agent in localAgentsFor(project)" :key="agent.id">
                            <NuxtLink
                              :to="`/agents/${agent.id}`"
                              class="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                              active-class="bg-elevated font-medium"
                            >
                              <StatusDot :status="agent.status">
                                <span class="sr-only">{{ agent.status }}</span>
                              </StatusDot>
                              <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                              <UChip
                                v-if="pendingByAgent.get(agent.id)"
                                :text="pendingByAgent.get(agent.id)"
                                color="warning"
                                size="sm"
                                standalone
                              />
                            </NuxtLink>
                          </li>
                        </ul>
                      </li>
                      <li v-for="environment in environmentsFor(project.id)" :key="environment.id">
                        <UCollapsible default-open>
                          <template #default="{ open }">
                            <button
                              type="button"
                              class="group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                            >
                              <UIcon
                                name="i-lucide-chevron-right"
                                class="size-3.5 shrink-0 text-dimmed transition-transform"
                                :class="{ 'rotate-90': open }"
                              />
                              <StatusDot :status="environment.status === 'running' ? 'idle' : environment.status">
                                <span class="sr-only">{{ environment.status }}</span>
                              </StatusDot>
                              <span class="min-w-0 flex-1 truncate text-left">{{ environment.name }}</span>
                              <UBadge
                                v-if="agentsFor(environment.id).length"
                                size="sm"
                                color="neutral"
                                variant="subtle"
                                :label="agentsFor(environment.id).length"
                              />
                            </button>
                          </template>

                          <template #content>
                            <ul class="mt-0.5 space-y-0.5 border-l border-default pl-3">
                              <li v-for="agent in agentsFor(environment.id)" :key="agent.id">
                                <NuxtLink
                                  :to="`/agents/${agent.id}`"
                                  class="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                                  active-class="bg-elevated font-medium"
                                >
                                  <StatusDot :status="agent.status">
                                    <span class="sr-only">{{ agent.status }}</span>
                                  </StatusDot>
                                  <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                                  <UChip
                                    v-if="pendingByAgent.get(agent.id)"
                                    :text="pendingByAgent.get(agent.id)"
                                    color="warning"
                                    size="sm"
                                    standalone
                                  />
                                </NuxtLink>
                              </li>
                              <li v-if="!agentsFor(environment.id).length" class="px-2 py-1 text-xs text-dimmed">
                                No agents yet
                              </li>
                            </ul>
                          </template>
                        </UCollapsible>
                      </li>
                      <li v-if="!environmentsFor(project.id).length" class="px-2 py-1 text-xs text-dimmed">
                        No environments yet
                      </li>
                    </ul>
                  </template>
                </UCollapsible>
              </li>
            </ul>
          </div>

          <div v-if="localAgents.length">
            <p class="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              Local agents
            </p>
            <ul class="space-y-0.5">
              <li v-for="agent in localAgents" :key="agent.id">
                <NuxtLink
                  :to="`/agents/${agent.id}`"
                  class="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                  active-class="bg-elevated font-medium"
                >
                  <StatusDot :status="agent.status">
                    <span class="sr-only">{{ agent.status }}</span>
                  </StatusDot>
                  <span class="min-w-0 flex-1 truncate">{{ agent.title }}</span>
                  <UChip
                    v-if="pendingByAgent.get(agent.id)"
                    :text="pendingByAgent.get(agent.id)"
                    color="warning"
                    size="sm"
                    standalone
                  />
                </NuxtLink>
              </li>
            </ul>
          </div>

          <div v-if="voiceSessions.length">
            <p class="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              Conversations
            </p>
            <ul class="space-y-0.5">
              <li v-for="session in voiceSessions" :key="session.id">
                <NuxtLink
                  :to="`/voice/${session.id}`"
                  class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
                  active-class="bg-elevated font-medium"
                >
                  <UIcon
                    :name="session.status === 'live' ? 'i-lucide-radio' : 'i-lucide-message-circle'"
                    class="size-4 shrink-0"
                    :class="session.status === 'live' ? 'text-primary' : 'text-dimmed'"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
                </NuxtLink>
              </li>
            </ul>
          </div>
        </div>

        <div v-else class="flex flex-col items-center gap-2">
          <UButton icon="i-lucide-mic" :loading="creating" @click="startConversation" />
          <UButton icon="i-lucide-plus" color="neutral" variant="ghost" @click="newAgentOpen = true" />
          <UButton to="/projects" icon="i-lucide-box" color="neutral" variant="ghost" />
        </div>
      </template>

      <template #footer="{ collapsed }">
        <div class="flex w-full items-center justify-between gap-2">
          <UButton
            to="/settings"
            icon="i-lucide-settings"
            :label="collapsed ? undefined : 'Settings'"
            color="neutral"
            variant="ghost"
            :block="!collapsed"
            class="justify-start"
          />
          <ColorModeButton v-if="!collapsed" />
        </div>
      </template>
    </UDashboardSidebar>

    <slot />

    <NewAgentModal v-model:open="newAgentOpen" />
  </UDashboardGroup>
</template>
