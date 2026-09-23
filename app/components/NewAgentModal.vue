<script setup lang="ts">
import type { AgentAdapter, SessionModeInfo } from '~~/shared/types'
import { AGENT_ADAPTERS, agentAdapterInfo } from '~~/shared/agent-adapters'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
  voiceSessionId?: string | null
  /**
   * Which project to start in. An agent belongs to a project's work even when
   * it runs outside a container, so the project is chosen first and everything
   * below it — which environments exist, where a local agent's directory
   * defaults to — follows from it.
   *
   * `undefined` leaves the choice to the modal; **`null` is the caller saying
   * "no project"**, which is how the sidebar's no-project section opens
   * straight onto an arbitrary path.
   */
  projectId?: string | null
  /**
   * Which environment to start in. The sidebar's per-environment plus button
   * passes it so the agent lands where it was asked for, and it decides the
   * project too. Left unset, the modal falls back to any running environment,
   * then to the first project's own checkout.
   */
  environmentId?: string | null
}>()

const router = useRouter()
const toast = useToast()

const title = ref('')
const cwd = ref('')
const task = ref('')
const submitting = ref(false)
const adapter = ref<AgentAdapter>('claude-code')
const adapterItems = AGENT_ADAPTERS.map(entry => ({ label: entry.label, value: entry.id }))
const selectedAdapter = computed(() => agentAdapterInfo(adapter.value))

// Reka's select items may not have an empty-string value, so "let the adapter
// decide" is a named sentinel rather than ''.
const ADAPTER_DEFAULT = 'adapter-default'
const model = ref(ADAPTER_DEFAULT)

// The adapter only reports its models and session modes in a
// `session/new` response, so both lists come from the server probing it — one
// request, one spawn. Keyed on the adapter, and lazy: nothing is spawned until
// the modal is actually opened.
const {
  data: modelData,
  status: modelStatus,
  error: modelError,
  refresh: refreshModels
} = await useFetch<{
  models: Array<{ id: string, name: string }>
  current: string | null
  modes: SessionModeInfo[]
  currentMode: string | null
}>(
  '/api/adapters/models',
  {
    query: computed(() => ({ adapter: adapter.value })),
    immediate: false,
    lazy: true,
    watch: false
  }
)

// A model id the adapter has not listed yet — the escape hatch for one that
// shipped after this Domo, or an account-specific alias.
const typedModels = ref<string[]>([])

const modelItems = computed(() => [
  { label: 'Adapter default', value: ADAPTER_DEFAULT },
  ...(modelData.value?.models ?? []).map(entry => ({ label: entry.name, value: entry.id })),
  ...typedModels.value.map(id => ({ label: id, value: id }))
])

const { data: settings } = await useFetch('/api/settings', { lazy: true })

// The mode this session starts in, preselected to the install's
// default for the chosen adapter. Never a sentinel: an empty v-model would show
// a blank menu, so the selected id is always one of the items — probed, typed,
// or the default itself while the probe is still out.
const mode = ref('')
const typedModes = ref<string[]>([])

function defaultMode(): string {
  return settings.value?.defaultAgentModes?.[adapter.value] ?? ''
}

const modeItems = computed(() => {
  const items = (modelData.value?.modes ?? []).map(entry => ({ label: entry.name, value: entry.id }))
  for (const id of [mode.value, ...typedModes.value]) {
    if (id && !items.some(item => item.value === id)) items.push({ label: id, value: id })
  }
  return items
})

const { environments } = useDevEnvironments()
const { projects } = useProjects()

// Reka's select items may not have an empty-string value, so neither "no
// project" nor "not in an environment" can be ''.
const NO_PROJECT = 'no-project'
const LOCAL = 'local'

const selectedProjectId = ref(NO_PROJECT)
const devEnvironmentId = ref(LOCAL)

const projectItems = computed(() => [
  ...projects.value.map(project => ({ label: project.name, value: project.id })),
  { label: 'No project', value: NO_PROJECT }
])

const selectedProject = computed(() => projects.value.find(project => project.id === selectedProjectId.value) ?? null)

/**
 * Where to run, *within* the chosen project: its checkout on the host, or one
 * of its containers. An environment always belongs to a project, so with none
 * chosen there is nothing to list and the form asks for a path instead.
 */
const environmentItems = computed(() => [
  { label: 'Local checkout (no container)', value: LOCAL },
  ...environments.value
    .filter(environment => environment.projectId === selectedProjectId.value)
    .map(environment => ({ label: environment.name, value: environment.id }))
])

/** The project's own checkout is where a local agent in it belongs by default. */
function defaultCwdFor(id: string): string {
  return projects.value.find(project => project.id === id)?.repoPath
    ?? settings.value?.defaultCwd
    ?? ''
}

function initialTarget(): { projectId: string, devEnvironmentId: string } {
  // An environment named by the caller wins, and it decides the project too.
  const named = props.environmentId
    ? environments.value.find(environment => environment.id === props.environmentId)
    : null
  if (named) return { projectId: named.projectId, devEnvironmentId: named.id }
  if (props.projectId) return { projectId: props.projectId, devEnvironmentId: LOCAL }
  // Only `undefined` means "you decide" — an explicit `null` is a choice.
  if (props.projectId === null) return { projectId: NO_PROJECT, devEnvironmentId: LOCAL }

  const running = environments.value.find(environment => environment.status === 'running')
  if (running) return { projectId: running.projectId, devEnvironmentId: running.id }
  const first = projects.value[0]
  if (first) return { projectId: first.id, devEnvironmentId: LOCAL }
  return { projectId: NO_PROJECT, devEnvironmentId: LOCAL }
}

// Settings are fetched lazily and may land after the modal is already open.
watch(settings, () => {
  if (!open.value) return
  if (!mode.value) mode.value = defaultMode()
  if (!cwd.value) cwd.value = defaultCwdFor(selectedProjectId.value)
})

/**
 * Changing the project re-points everything under it. The environment is kept
 * only when it belongs to the project now chosen, which is what lets the open
 * handler below set both in one go without this undoing it.
 */
watch(selectedProjectId, (id) => {
  const stillThere = environments.value.some(
    environment => environment.id === devEnvironmentId.value && environment.projectId === id
  )
  if (!stillThere) devEnvironmentId.value = LOCAL
  cwd.value = defaultCwdFor(id)
})

// `immediate`, because the modal may be mounted already open — without it the
// form would show the refs' own initial values rather than what was asked for.
watch(open, (value) => {
  if (!value) return
  title.value = ''
  task.value = ''
  model.value = ADAPTER_DEFAULT
  adapter.value = 'claude-code'
  const target = initialTarget()
  selectedProjectId.value = target.projectId
  devEnvironmentId.value = target.devEnvironmentId
  cwd.value = defaultCwdFor(target.projectId)
}, { immediate: true })

// Asking costs an adapter spawn, so it happens when the modal opens and again
// only if the adapter changes — never on every keystroke elsewhere in the form.
// `immediate`, because the modal may be mounted already open.
watch([open, adapter], ([isOpen]) => {
  if (!isOpen) return
  model.value = ADAPTER_DEFAULT
  typedModels.value = []
  mode.value = defaultMode()
  typedModes.value = []
  refreshModels()
}, { immediate: true })

async function create() {
  if (!title.value.trim() && !task.value.trim()) return
  submitting.value = true
  try {
    const session = await $fetch<{ id: string }>('/api/agents', {
      method: 'POST',
      body: {
        title: title.value.trim() || task.value.trim().slice(0, 60),
        adapter: adapter.value,
        // The environment's own workspace is the directory when there is one,
        // so the picked path only means anything for a local session.
        cwd: devEnvironmentId.value === LOCAL ? (cwd.value.trim() || undefined) : undefined,
        model: model.value === ADAPTER_DEFAULT ? undefined : model.value,
        modeId: mode.value || undefined,
        devEnvironmentId: devEnvironmentId.value === LOCAL ? undefined : devEnvironmentId.value,
        voiceSessionId: props.voiceSessionId ?? null,
        initialPrompt: task.value.trim() || undefined
      }
    })
    open.value = false
    await router.push(`/agents/${session.id}`)
  } catch (error: any) {
    toast.add({
      title: 'Could not start the agent',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="New coding agent"
    description="Starts a coding agent over ACP in a project's checkout, one of its development environments, or any directory on this machine."
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Agent">
          <USelectMenu
            v-model="adapter"
            :items="adapterItems"
            value-key="value"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Name" hint="How you'll refer to it out loud">
          <UInput v-model="title" placeholder="auth refactor" class="w-full" autofocus />
        </UFormField>

        <UFormField label="Model">
          <USelectMenu
            v-model="model"
            :items="modelItems"
            value-key="value"
            :loading="modelStatus === 'pending'"
            create-item
            class="w-full"
            @create="(id: string) => { typedModels.push(id); model = id }"
          />
          <template #help>
            <span v-if="modelError" class="text-xs text-error">
              Could not ask {{ selectedAdapter.label }} which models it offers:
              {{ modelError.statusMessage ?? modelError.message }}
            </span>
            <span v-else class="text-xs text-muted">
              Leave on the default unless this agent needs a specific model.
            </span>
          </template>
        </UFormField>

        <UFormField :label="selectedAdapter.modeLabel">
          <USelectMenu
            v-model="mode"
            :items="modeItems"
            value-key="value"
            :loading="modelStatus === 'pending'"
            create-item
            class="w-full"
            placeholder="Agent default"
            @create="(id: string) => { typedModes.push(id); mode = id }"
          />
          <template #help>
            <span class="text-xs text-muted">
              {{ selectedAdapter.modeDescription }} Defaults to your setting for
              {{ selectedAdapter.label }}.
            </span>
          </template>
        </UFormField>

        <UFormField label="Project">
          <USelectMenu
            v-model="selectedProjectId"
            :items="projectItems"
            value-key="value"
            class="w-full"
          />
          <template #help>
            <span class="text-xs text-muted">
              Agents usually belong to a project. Pick "No project" to work in an
              arbitrary directory instead.
            </span>
          </template>
        </UFormField>

        <UFormField v-if="selectedProject" label="Where">
          <USelectMenu
            v-model="devEnvironmentId"
            :items="environmentItems"
            value-key="value"
            class="w-full"
          />
          <template #help>
            <span class="text-xs text-muted">
              The local checkout is {{ selectedProject.repoPath }} on this machine.
              Environments are containers with a private copy of it, and can be
              shared by multiple agents.
            </span>
          </template>
        </UFormField>

        <UFormField v-if="devEnvironmentId === LOCAL" label="Working directory">
          <DirectoryPicker v-model="cwd" />
        </UFormField>

        <UFormField label="First task" hint="Optional — it starts working right away">
          <UTextarea
            v-model="task"
            :rows="4"
            class="w-full"
            placeholder="Split the auth module into a service and a router, keep the tests green."
          />
        </UFormField>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          label="Start agent"
          icon="i-lucide-play"
          :loading="submitting"
          :disabled="!title.trim() && !task.trim()"
          @click="create"
        />
      </div>
    </template>
  </UModal>
</template>
