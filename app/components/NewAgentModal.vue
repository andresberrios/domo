<script setup lang="ts">
import type { AgentAdapter, SessionModeInfo } from '~~/shared/types'

const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{ voiceSessionId?: string | null }>()

const router = useRouter()
const toast = useToast()

const title = ref('')
const cwd = ref('')
const task = ref('')
const submitting = ref(false)
const adapter = ref<AgentAdapter>('claude-code')
const adapterItems = [
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Codex', value: 'codex' }
]

// Reka's select items may not have an empty-string value, so "let the adapter
// decide" is a named sentinel rather than ''.
const ADAPTER_DEFAULT = 'adapter-default'
const model = ref(ADAPTER_DEFAULT)

// The adapter only reports its models *and its permission modes* in a
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

// The permission mode this session starts in, preselected to the install's
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

// Settings are fetched lazily and may land after the modal is already open.
watch(settings, () => {
  if (open.value && !mode.value) mode.value = defaultMode()
})

const { environments } = useDevEnvironments()
const { projects } = useProjects()

// Reka's select items may not have an empty-string value, so "no environment"
// is a named sentinel rather than ''.
const LOCAL = 'local'
const devEnvironmentId = ref(LOCAL)
const environmentItems = computed(() => [
  { label: 'Local host directory', value: LOCAL },
  ...environments.value.map(environment => ({
    label: `${projects.value.find(project => project.id === environment.projectId)?.name ?? 'Project'} / ${environment.name}`,
    value: environment.id
  }))
])

watch(open, async (value) => {
  if (!value) return
  title.value = ''
  task.value = ''
  model.value = ADAPTER_DEFAULT
  adapter.value = 'claude-code'
  cwd.value = settings.value?.defaultCwd ?? ''
  devEnvironmentId.value = environments.value.find(environment => environment.status === 'running')?.id ?? LOCAL
})

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
        cwd: cwd.value.trim() || undefined,
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
    description="Starts a coding agent over ACP in a local directory or development environment."
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
              Could not ask {{ adapter === 'codex' ? 'Codex' : 'Claude Code' }} which models it offers:
              {{ modelError.statusMessage ?? modelError.message }}
            </span>
            <span v-else class="text-xs text-muted">
              Leave on the default unless this agent needs a specific model.
            </span>
          </template>
        </UFormField>

        <UFormField label="Permission mode">
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
              How much this agent may do before it asks. Defaults to your setting for
              {{ adapter === 'codex' ? 'Codex' : 'Claude Code' }}.
            </span>
          </template>
        </UFormField>

        <UFormField label="Development environment">
          <USelectMenu
            v-model="devEnvironmentId"
            :items="environmentItems"
            value-key="value"
            class="w-full"
          />
          <template #help>
            <span class="text-xs text-muted">
              Environments can be shared by multiple agents.
              <NuxtLink to="/projects" class="text-primary">Manage environments</NuxtLink>
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
