<script setup lang="ts">
import { environmentListRows } from '~~/shared/dev-environments'
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

/** A project's environments as folders by the slashes in their names; a collapsed folder hides what it holds. */
function environmentRowsFor(projectId: string) {
  return environmentListRows(environmentsFor(projectId), path => !isExpanded(folderKey(projectId, path)))
}

/** Where the open state of a project's local checkout is remembered. */
function localKey(projectId: string) {
  return `local:${projectId}`
}

/** Where a folder's open state is remembered: the same name in two projects is two folders. */
function folderKey(projectId: string, path: string) {
  return `folder:${projectId}:${path}`
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
  <div class="flex flex-col gap-5">
    <section>
      <div class="flex items-center justify-between gap-1 ps-2 pb-1">
        <h2 class="text-xs font-medium text-muted">
          Projects
        </h2>
        <div class="flex items-center">
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

      <div v-if="!projects.length" class="rounded-lg border border-dashed border-default px-3 py-3 text-xs text-muted">
        A project is a git checkout on this machine. Each one gets environments of its own to run agents in.
        <UButton label="Add a project" color="primary" variant="link" size="xs" class="px-0" @click="newProjectOpen = true" />
      </div>

      <!-- One group per project: everything inside it reads as belonging to it. -->
      <ul class="flex flex-col gap-2">
        <li v-for="project in projects" :key="project.id" class="rounded-lg bg-muted p-1 ring ring-default">
          <SidebarProjectRow
            :project="project"
            :expanded="isExpanded(project.id)"
            :agent-count="projectAgentCount(project)"
            :environment-count="environmentsFor(project.id).length"
            @toggle="toggle(project.id)"
            @new-environment="openNewEnvironment(project)"
            @new-agent="openNewAgent({ projectId: project.id })"
          />

          <ul v-show="isExpanded(project.id)" class="mt-0.5 flex flex-col gap-px ps-2">
            <!-- The project's own checkout, only once something runs there; its menu starts one. -->
            <li v-if="localAgentsFor(project).length">
              <div :class="ROW_CLASS">
                <SidebarDisclosure
                  :expanded="isExpanded(localKey(project.id))"
                  :label="`the ${project.name} checkout`"
                  @toggle="toggle(localKey(project.id))"
                />
                <span class="flex min-w-0 flex-1 items-center gap-2" :title="project.repoPath">
                  <UIcon name="i-lucide-laptop" class="size-4 shrink-0 text-muted" />
                  <span class="min-w-0 flex-1 truncate">Local checkout</span>
                </span>
                <span v-if="!isExpanded(localKey(project.id))" class="px-1 text-xs tabular-nums text-dimmed" :class="ROW_BADGE_CLASS">
                  {{ localAgentsFor(project).length }}
                </span>
                <UButton
                  icon="i-lucide-plus"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :aria-label="`New agent in the ${project.name} checkout`"
                  :class="ROW_MENU_CLASS"
                  @click="openNewAgent({ projectId: project.id })"
                />
              </div>
              <ul v-show="isExpanded(localKey(project.id))" class="ms-3 flex flex-col gap-px border-s border-accented ps-3">
                <li v-for="agent in localAgentsFor(project)" :key="agent.id">
                  <SidebarAgentRow :agent="agent" :pending="pendingByAgent.get(agent.id)" />
                </li>
              </ul>
            </li>

            <li
              v-for="row in environmentRowsFor(project.id)"
              :key="row.kind === 'folder' ? folderKey(project.id, row.path) : row.environment.id"
              :style="{ paddingInlineStart: `${row.depth * 0.625}rem` }"
            >
              <div v-if="row.kind === 'folder'" :class="ROW_CLASS" :title="row.path">
                <SidebarDisclosure
                  :expanded="isExpanded(folderKey(project.id, row.path))"
                  :label="row.path"
                  @toggle="toggle(folderKey(project.id, row.path))"
                />
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 self-stretch text-start text-muted"
                  @click="toggle(folderKey(project.id, row.path))"
                >
                  <UIcon
                    :name="isExpanded(folderKey(project.id, row.path)) ? 'i-lucide-folder-open' : 'i-lucide-folder'"
                    class="size-4 shrink-0"
                  />
                  <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
                </button>
                <span v-if="!isExpanded(folderKey(project.id, row.path))" class="px-1 text-xs tabular-nums text-dimmed">
                  {{ row.count }}
                </span>
              </div>

              <template v-else>
                <SidebarEnvironmentRow
                  :environment="row.environment"
                  :label="row.label"
                  :expanded="isExpanded(row.environment.id)"
                  :agent-count="agentsFor(row.environment.id).length"
                  @toggle="toggle(row.environment.id)"
                  @new-agent="openNewAgent({ environmentId: row.environment.id })"
                />
                <ul
                  v-if="agentsFor(row.environment.id).length"
                  v-show="isExpanded(row.environment.id)"
                  class="ms-3 flex flex-col gap-px border-s border-accented ps-3"
                >
                  <li v-for="agent in agentsFor(row.environment.id)" :key="agent.id">
                    <SidebarAgentRow :agent="agent" :pending="pendingByAgent.get(agent.id)" />
                  </li>
                </ul>
              </template>
            </li>

            <li v-if="!environmentsFor(project.id).length && !localAgentsFor(project).length">
              <UButton
                label="New environment"
                icon="i-lucide-plus"
                color="neutral"
                variant="ghost"
                size="sm"
                block
                class="justify-start ps-6 text-muted"
                @click="openNewEnvironment(project)"
              />
            </li>
          </ul>
        </li>
      </ul>
    </section>

    <!-- Agents in a directory no project covers. Shown only when there are some: the plus above starts one. -->
    <section v-if="localAgents.length">
      <h2 class="ps-2 pb-1 text-xs font-medium text-muted">
        Other directories
      </h2>
      <ul class="flex flex-col gap-px rounded-lg bg-muted p-1 ring ring-default">
        <li v-for="agent in localAgents" :key="agent.id">
          <SidebarAgentRow :agent="agent" :pending="pendingByAgent.get(agent.id)" />
        </li>
      </ul>
    </section>

    <section v-if="voiceSessions.length">
      <h2 class="ps-2 pb-1 text-xs font-medium text-muted">
        Conversations
      </h2>
      <ul class="flex flex-col gap-px">
        <li v-for="session in voiceSessions" :key="session.id">
          <SidebarConversationRow :session="session" />
        </li>
      </ul>
    </section>

    <NewProjectModal v-model:open="newProjectOpen" />
    <NewEnvironmentModal v-model:open="newEnvironmentOpen" :project="newEnvironmentProject" />
    <NewAgentModal
      v-model:open="newAgentOpen"
      :project-id="newAgentTarget.projectId"
      :environment-id="newAgentTarget.environmentId"
    />
  </div>
</template>
