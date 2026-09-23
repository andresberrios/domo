<script setup lang="ts">
import type { Project } from '~~/shared/types'

/**
 * The sidebar's management surface: projects → environments → agents, plus the
 * conversations below them.
 *
 * Built from plain rows rather than `UCollapsible` wrapping a button. The
 * default shape makes a row *either* a link or a disclosure and leaves nowhere
 * for inline actions to live, and every row here has to be all three.
 */
const { projects } = useProjects()
const { environments, showRetired } = useDevEnvironments()
const { sessions: agentSessions, showArchived } = useAgentSessions()
const { sessions: voiceSessions } = useVoiceSessions()
const { pending } = usePermissions()

/**
 * What the user has *closed*, not what they have opened.
 *
 * Rows default to open, so the set worth remembering is the small one. An
 * expanded-id set would start a fresh sidebar fully collapsed and would also
 * collapse every project created after it was written.
 */
const STORAGE_KEY = 'domo.sidebar.collapsed'
const collapsed = ref<Set<string>>(new Set())

onMounted(() => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(stored)) collapsed.value = new Set(stored.filter(id => typeof id === 'string'))
  } catch {
    // A corrupt entry is not worth a broken sidebar; start everything open.
  }
})

function isExpanded(id: string) {
  return !collapsed.value.has(id)
}

function toggle(id: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(id)) next.add(id)
  collapsed.value = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // Private mode, quota, no storage at all: the tree still works this session.
  }
}

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

/* The modals the rows ask for. One instance each, owned here, because a row is
 * unmounted the moment its project or environment is deleted. */
const newProjectOpen = ref(false)
const newEnvironmentOpen = ref(false)
const newEnvironmentProject = ref<Project | null>(null)
const newAgentOpen = ref(false)

/**
 * Where the next agent should start, as the row that asked for it knows it.
 *
 * `projectId: undefined` leaves the choice to the modal; `null` is this tree
 * saying "no project", which is what the no-project section's plus means.
 */
const newAgentTarget = ref<{ projectId?: string | null, environmentId?: string }>({})

function openNewEnvironment(project: Project) {
  newEnvironmentProject.value = project
  newEnvironmentOpen.value = true
}

function openNewAgent(target: { projectId?: string | null, environmentId?: string }) {
  newAgentTarget.value = target
  newAgentOpen.value = true
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <div class="flex items-center justify-between gap-1 px-2 pb-1.5">
        <p class="text-[11px] font-medium uppercase tracking-wide text-dimmed">
          Projects
        </p>
        <div class="flex items-center gap-0.5">
          <!--
            Two switches, never one. Archiving is what the user put away;
            retiring an environment is a place whose container is gone. Every
            session in a retired environment is unstartable and none of them is
            archived, so neither switch can stand in for the other.
          -->
          <UDropdownMenu
            :items="[[
              { label: 'Show archived sessions', icon: 'i-lucide-archive', type: 'checkbox' as const, checked: showArchived, onUpdateChecked: (value: boolean) => { showArchived = value } },
              { label: 'Show retired environments', icon: 'i-lucide-box', type: 'checkbox' as const, checked: showRetired, onUpdateChecked: (value: boolean) => { showRetired = value } }
            ]]"
            :content="{ align: 'end' }"
          >
            <UButton
              icon="i-lucide-eye"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="What to show"
            />
          </UDropdownMenu>
          <UButton
            icon="i-lucide-plus"
            color="neutral"
            variant="ghost"
            size="xs"
            aria-label="New project"
            @click="newProjectOpen = true"
          />
        </div>
      </div>

      <p v-if="!projects.length" class="px-2 pb-1 text-xs text-dimmed">
        No projects yet.
      </p>

      <ul class="space-y-0.5">
        <li v-for="project in projects" :key="project.id">
          <SidebarProjectRow
            :project="project"
            :expanded="isExpanded(project.id)"
            :agent-count="projectAgentCount(project)"
            :environment-count="environmentsFor(project.id).length"
            @toggle="toggle(project.id)"
            @new-environment="openNewEnvironment(project)"
          />

          <ul v-show="isExpanded(project.id)" class="mt-0.5 space-y-0.5 border-l border-default ps-3">
            <li>
              <div class="group flex items-center gap-1 rounded-md pe-1">
                <p class="min-w-0 flex-1 truncate px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-dimmed">
                  Local checkout
                </p>
                <UButton
                  icon="i-lucide-plus"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :aria-label="`New agent in the ${project.name} checkout`"
                  :class="ROW_ACTIONS_CLASS"
                  @click="openNewAgent({ projectId: project.id })"
                />
              </div>
              <ul class="space-y-0.5">
                <li v-for="agent in localAgentsFor(project)" :key="agent.id">
                  <SidebarAgentRow :agent="agent" :pending="pendingByAgent.get(agent.id)" />
                </li>
                <li v-if="!localAgentsFor(project).length" class="px-2 py-1 text-xs text-dimmed">
                  No agents yet
                </li>
              </ul>
            </li>

            <li v-for="environment in environmentsFor(project.id)" :key="environment.id">
              <SidebarEnvironmentRow
                :environment="environment"
                :expanded="isExpanded(environment.id)"
                :agent-count="agentsFor(environment.id).length"
                @toggle="toggle(environment.id)"
                @new-agent="openNewAgent({ environmentId: environment.id })"
              />

              <ul v-show="isExpanded(environment.id)" class="mt-0.5 space-y-0.5 border-l border-default ps-3">
                <li v-for="agent in agentsFor(environment.id)" :key="agent.id">
                  <SidebarAgentRow :agent="agent" :pending="pendingByAgent.get(agent.id)" />
                </li>
                <li v-if="!agentsFor(environment.id).length" class="px-2 py-1 text-xs text-dimmed">
                  No agents yet
                </li>
              </ul>
            </li>

            <li v-if="!environmentsFor(project.id).length" class="px-2 py-1 text-xs text-dimmed">
              No environments yet
            </li>
          </ul>
        </li>
      </ul>
    </div>

    <div class="group">
      <div class="flex items-center justify-between gap-1 px-2 pb-1.5">
        <p class="text-[11px] font-medium uppercase tracking-wide text-dimmed">
          No project
        </p>
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="ghost"
          size="xs"
          aria-label="New agent without a project"
          :class="ROW_ACTIONS_CLASS"
          @click="openNewAgent({ projectId: null })"
        />
      </div>

      <p v-if="!localAgents.length" class="px-2 pb-1 text-xs text-dimmed">
        For a directory outside every project.
      </p>

      <ul class="space-y-0.5">
        <li v-for="agent in localAgents" :key="agent.id">
          <SidebarAgentRow :agent="agent" :pending="pendingByAgent.get(agent.id)" />
        </li>
      </ul>
    </div>

    <div v-if="voiceSessions.length">
      <p class="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-dimmed">
        Conversations
      </p>
      <ul class="space-y-0.5">
        <li v-for="session in voiceSessions" :key="session.id">
          <SidebarConversationRow :session="session" />
        </li>
      </ul>
    </div>

    <NewProjectModal v-model:open="newProjectOpen" />
    <NewEnvironmentModal v-model:open="newEnvironmentOpen" :project="newEnvironmentProject" />
    <NewAgentModal
      v-model:open="newAgentOpen"
      :project-id="newAgentTarget.projectId"
      :environment-id="newAgentTarget.environmentId"
    />
  </div>
</template>
