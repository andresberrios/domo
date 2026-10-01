<script setup lang="ts">
import type { AgentAdapter, Assistant, SessionModeInfo } from '~~/shared/types'
import { AGENT_ADAPTERS, agentAdapterInfo } from '~~/shared/agent-adapters'
import {
  DEFAULT_HANDOFF_THRESHOLD,
  HANDOFF_THRESHOLD_MAX,
  HANDOFF_THRESHOLD_MIN,
  supportsSystemPrompt
} from '~~/shared/assistants'

/**
 * Making an assistant, or changing one. Who it is (picture, name, persona)
 * and what its sessions run on (harness, model, mode, workspace), plus when
 * it hands off by itself. Editing changes who it is at once; what it runs on
 * applies from its next session.
 */
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ assistant?: Assistant | null }>()

const router = useRouter()
const toast = useToast()
const { data: settings } = useSettings()
const { projects } = useProjects()
const { environments } = useDevEnvironments()

const editing = computed(() => !!props.assistant)

// Reka's select items may not have an empty-string value.
const ADAPTER_DEFAULT = 'adapter-default'
const NO_PROJECT = 'no-project'
const LOCAL = 'local'

const form = reactive({
  name: '',
  avatar: null as string | null,
  persona: '',
  adapter: 'claude-code' as AgentAdapter,
  model: ADAPTER_DEFAULT,
  mode: '',
  projectId: NO_PROJECT,
  devEnvironmentId: LOCAL,
  cwd: '',
  autoHandoff: true,
  threshold: DEFAULT_HANDOFF_THRESHOLD
})
const submitting = ref(false)
const typedModels = ref<string[]>([])

const adapterItems = AGENT_ADAPTERS.map(entry => ({ label: entry.label, value: entry.id }))
const selectedAdapter = computed(() => agentAdapterInfo(form.adapter))

const { data: modelData, status: modelStatus, refresh: refreshModels } = await useFetch<{
  models: Array<{ id: string, name: string }>
  modes: SessionModeInfo[]
}>('/api/adapters/models', {
  query: computed(() => ({ adapter: form.adapter })),
  immediate: false,
  lazy: true,
  watch: false
})

const modelItems = computed(() => {
  const items = [
    { label: 'Adapter default', value: ADAPTER_DEFAULT },
    ...(modelData.value?.models ?? []).map(entry => ({ label: entry.name, value: entry.id }))
  ]
  for (const id of [form.model, ...typedModels.value]) {
    if (id && !items.some(item => item.value === id)) items.push({ label: id, value: id })
  }
  return items
})

const modeItems = computed(() => {
  const items = (modelData.value?.modes ?? []).map(entry => ({ label: entry.name, value: entry.id }))
  if (form.mode && !items.some(item => item.value === form.mode)) items.push({ label: form.mode, value: form.mode })
  return items
})

const projectItems = computed(() => [
  ...projects.value.map(project => ({ label: project.name, value: project.id })),
  { label: 'No project', value: NO_PROJECT }
])
const selectedProject = computed(() => projects.value.find(project => project.id === form.projectId) ?? null)
const environmentItems = computed(() => [
  { label: 'Local checkout (no container)', value: LOCAL },
  ...environments.value
    .filter(environment => environment.projectId === form.projectId)
    .map(environment => ({ label: environment.name, value: environment.id }))
])

/** A project whose checkout holds this directory, if any. */
function projectOf(cwd: string): string {
  const match = projects.value.find(project => cwd === project.repoPath || cwd.startsWith(`${project.repoPath.replace(/\/+$/, '')}/`))
  return match?.id ?? NO_PROJECT
}

function reset() {
  const assistant = props.assistant
  typedModels.value = []
  if (assistant) {
    const environment = environments.value.find(item => item.id === assistant.devEnvironmentId)
    Object.assign(form, {
      name: assistant.name,
      avatar: assistant.avatar,
      persona: assistant.persona,
      adapter: assistant.adapter,
      model: assistant.model ?? ADAPTER_DEFAULT,
      mode: assistant.modeId ?? '',
      projectId: environment?.projectId ?? projectOf(assistant.cwd),
      devEnvironmentId: environment?.id ?? LOCAL,
      cwd: assistant.cwd,
      autoHandoff: assistant.handoffThreshold !== null,
      threshold: assistant.handoffThreshold ?? DEFAULT_HANDOFF_THRESHOLD
    })
  } else {
    Object.assign(form, {
      name: '',
      avatar: null,
      persona: '',
      adapter: 'claude-code',
      model: ADAPTER_DEFAULT,
      mode: settings.value?.defaultAgentModes?.['claude-code'] ?? '',
      projectId: NO_PROJECT,
      devEnvironmentId: LOCAL,
      cwd: settings.value?.defaultCwd ?? '',
      autoHandoff: true,
      threshold: DEFAULT_HANDOFF_THRESHOLD
    })
  }
}

// Set the whole form when it opens; changing the harness re-asks it for its
// models and modes, which costs an adapter spawn, so only then.
let resetting = false
watch(open, async (value) => {
  if (!value) return
  resetting = true
  reset()
  await nextTick()
  resetting = false
  refreshModels()
}, { immediate: true })

watch(() => form.adapter, (adapter) => {
  if (resetting || !open.value) return
  form.model = ADAPTER_DEFAULT
  form.mode = settings.value?.defaultAgentModes?.[adapter] ?? ''
  refreshModels()
})

watch(() => form.projectId, (id) => {
  if (resetting) return
  if (!environments.value.some(environment => environment.id === form.devEnvironmentId && environment.projectId === id)) {
    form.devEnvironmentId = LOCAL
  }
  form.cwd = projects.value.find(project => project.id === id)?.repoPath ?? settings.value?.defaultCwd ?? ''
})

/** Drawing a picture from the name and persona: about a minute, on the ChatGPT plan through Codex. */
const generating = ref(false)
async function generateAvatar() {
  generating.value = true
  try {
    const { avatar } = await $fetch<{ avatar: string }>('/api/assistants/avatar', {
      method: 'POST',
      body: { name: form.name, persona: form.persona },
      timeout: 6 * 60_000
    })
    form.avatar = avatar
  } catch (error: any) {
    toast.add({ title: 'Could not generate a picture', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    generating.value = false
  }
}

const fileInput = ref<HTMLInputElement | null>(null)
async function pickAvatar(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    form.avatar = await shrinkAvatar(file)
  } catch (error: any) {
    toast.add({ title: 'Could not use that picture', description: error?.message, color: 'error' })
  } finally {
    (event.target as HTMLInputElement).value = ''
  }
}

async function save() {
  if (!form.name.trim()) return
  submitting.value = true
  const body = {
    name: form.name.trim(),
    // Only a new picture: the server re-encodes what it is sent.
    ...props.assistant?.avatar === form.avatar ? {} : { avatar: form.avatar },
    persona: form.persona,
    adapter: form.adapter,
    model: form.model === ADAPTER_DEFAULT ? null : form.model,
    modeId: form.mode || null,
    devEnvironmentId: form.devEnvironmentId === LOCAL ? null : form.devEnvironmentId,
    cwd: form.devEnvironmentId === LOCAL ? form.cwd.trim() : undefined,
    handoffThreshold: form.autoHandoff ? form.threshold : null
  }
  try {
    if (props.assistant) {
      await $fetch(`/api/assistants/${props.assistant.id}`, { method: 'PATCH', body })
      open.value = false
    } else {
      const created = await $fetch<Assistant>('/api/assistants', { method: 'POST', body })
      open.value = false
      await router.push(`/assistants/${created.id}`)
    }
  } catch (error: any) {
    toast.add({
      title: props.assistant ? 'Could not save the assistant' : 'Could not create the assistant',
      description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message,
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
    :title="editing ? `Edit ${assistant?.name}` : 'New assistant'"
    :description="editing
      ? 'Name, picture and persona change now. Harness, model and workspace apply from its next session.'
      : 'An assistant keeps one conversation with you for as long as you like. When its context fills up it writes itself a note and carries on in a fresh session.'"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <div class="flex items-end gap-3">
          <button
            type="button"
            class="group relative shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-primary"
            :aria-label="form.avatar ? 'Change the picture' : 'Add a picture'"
            @click="fileInput?.click()"
          >
            <UAvatar :src="form.avatar ?? undefined" :alt="form.name || '?'" size="3xl" />
            <span class="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100">
              <UIcon name="i-lucide-camera" class="size-5" />
            </span>
          </button>
          <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="pickAvatar">
          <UFormField label="Name" class="flex-1">
            <UInput v-model="form.name" placeholder="Inbox organizer" class="w-full" autofocus />
          </UFormField>
          <UTooltip text="Draw one from the name and persona. About a minute, on your ChatGPT plan through Codex.">
            <UButton
              icon="i-lucide-wand-sparkles"
              :label="generating ? 'Drawing…' : 'Generate'"
              color="neutral"
              variant="subtle"
              :loading="generating"
              :disabled="!form.name.trim()"
              @click="generateAvatar"
            />
          </UTooltip>
          <UButton
            v-if="form.avatar"
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            aria-label="Remove the picture"
            @click="form.avatar = null"
          />
        </div>

        <UFormField label="Persona" hint="Who it is and how it works">
          <UTextarea
            v-model="form.persona"
            :rows="6"
            autoresize
            :maxrows="14"
            class="w-full"
            placeholder="You organise my email. Every morning, file newsletters, flag anything from my team, and give me a three-line summary. Be brief and a little dry."
          />
          <template #help>
            <span class="text-xs text-muted">
              {{ supportsSystemPrompt(form.adapter)
                ? `${selectedAdapter.label} takes this as part of its system prompt.`
                : `${selectedAdapter.label} has no system prompt, so this goes, hidden, at the start of each of its sessions.` }}
            </span>
          </template>
        </UFormField>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Harness">
            <ChoiceMenu v-model="form.adapter" :items="adapterItems" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Model">
            <ChoiceMenu
              v-model="form.model"
              :items="modelItems"
              value-key="value"
              :loading="modelStatus === 'pending'"
              create-item
              class="w-full"
              @create="(id: string) => { typedModels.push(id); form.model = id }"
            />
          </UFormField>
        </div>

        <UFormField :label="selectedAdapter.modeLabel">
          <ChoiceMenu
            v-model="form.mode"
            :items="modeItems"
            value-key="value"
            :loading="modelStatus === 'pending'"
            class="w-full"
            placeholder="Agent default"
          />
          <template #help>
            <span class="text-xs text-muted">{{ selectedAdapter.modeDescription }}</span>
          </template>
        </UFormField>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="Project">
            <ChoiceMenu v-model="form.projectId" :items="projectItems" value-key="value" class="w-full" />
          </UFormField>
          <UFormField v-if="selectedProject" label="Where">
            <ChoiceMenu v-model="form.devEnvironmentId" :items="environmentItems" value-key="value" class="w-full" />
          </UFormField>
        </div>

        <UFormField v-if="form.devEnvironmentId === LOCAL" label="Working directory">
          <DirectoryPicker v-model="form.cwd" />
        </UFormField>

        <UFormField label="Fresh start">
          <div class="flex flex-wrap items-center gap-3">
            <USwitch v-model="form.autoHandoff" label="By itself when the context is" />
            <UInputNumber
              v-model="form.threshold"
              :min="HANDOFF_THRESHOLD_MIN"
              :max="HANDOFF_THRESHOLD_MAX"
              :step="5"
              :disabled="!form.autoHandoff"
              class="w-28"
            />
            <span class="text-sm text-muted">% full</span>
          </div>
          <template #help>
            <span class="text-xs text-muted">
              You can always ask for one, from its page or in words ("clean up your context").
            </span>
          </template>
        </UFormField>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          :label="editing ? 'Save' : 'Create assistant'"
          :icon="editing ? 'i-lucide-check' : 'i-lucide-sparkles'"
          :loading="submitting"
          :disabled="!form.name.trim()"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>
