<script setup lang="ts">
import type { AgentAdapter } from '~~/shared/types'

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

const { data: settings } = await useFetch('/api/settings', { lazy: true })
const { environments } = useDevEnvironments()
const { projects } = useProjects()

const devEnvironmentId = ref('')
const environmentItems = computed(() => [
  { label: 'Local host directory', value: '' },
  ...environments.value.map(environment => ({
    label: `${projects.value.find(project => project.id === environment.projectId)?.name ?? 'Project'} / ${environment.name}`,
    value: environment.id
  }))
])

watch(open, async (value) => {
  if (!value) return
  title.value = ''
  task.value = ''
  adapter.value = 'claude-code'
  cwd.value = settings.value?.defaultCwd ?? ''
  devEnvironmentId.value = environments.value.find(environment => environment.status === 'running')?.id ?? ''
})

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
        devEnvironmentId: devEnvironmentId.value || undefined,
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

        <UFormField v-if="!devEnvironmentId" label="Working directory">
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
