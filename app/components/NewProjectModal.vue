<script setup lang="ts">
import { watchDebounced } from '@vueuse/core'
import type { Project, ProjectPathState } from '~~/shared/types'

/**
 * Adding a project is now a sidebar action, so the form lives in the modal
 * rather than on a page. One implementation: the project details page links
 * back here too.
 *
 * The folder can be an existing checkout, a folder that is not a repository
 * yet, or a path that does not exist. What Domo would do to it is read from
 * the server as the path changes and said before anything is written, and the
 * button names it.
 */
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [project: Project] }>()

const toast = useToast()
const name = ref('')
const repoPath = ref('')
const submitting = ref(false)
const state = ref<ProjectPathState | null>(null)
const inspecting = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  repoPath.value = ''
  state.value = null
})

let inspection = 0
async function inspect() {
  const path = repoPath.value.trim()
  const ticket = ++inspection
  if (!path) {
    state.value = null
    inspecting.value = false
    return
  }
  inspecting.value = true
  try {
    const result = await $fetch<ProjectPathState>('/api/projects/inspect-path', { query: { path } })
    if (ticket === inspection) state.value = result
  } catch {
    if (ticket === inspection) state.value = null
  } finally {
    if (ticket === inspection) inspecting.value = false
  }
}
// Typing marks the answer stale at once, so the button never acts on the previous path.
watch(repoPath, () => {
  inspecting.value = !!repoPath.value.trim()
})
watchDebounced(repoPath, inspect, { debounce: 250 })

const initialize = computed(() => state.value?.kind === 'directory' || state.value?.kind === 'missing')

const submitLabel = computed(() => {
  if (state.value?.kind === 'missing') return 'Create and add'
  if (state.value?.kind === 'directory') return 'Initialise and add'
  return 'Add project'
})

/** One line under the field: what adding does to this path. */
const plan = computed<{ icon: string, color: string, text: string } | null>(() => {
  const value = state.value
  if (!value || value.problem) return null
  if (value.kind === 'repository') {
    return { icon: 'i-lucide-git-branch', color: 'text-success', text: 'A git checkout. It stays where it is. Environments share its branches and commits, so a branch an agent makes in one shows up here at once.' }
  }
  if (value.kind === 'missing') {
    const folders = value.toCreate.length > 1
      ? `Creates ${value.toCreate.length} folders (${value.toCreate.map(path => path.split('/').pop()).join(' / ')})`
      : 'Creates this folder'
    return { icon: 'i-lucide-folder-plus', color: 'text-info', text: `${folders}, runs git init on branch main and makes an empty first commit.` }
  }
  return value.empty
    ? { icon: 'i-lucide-git-commit-horizontal', color: 'text-info', text: 'Not a git repository yet. Runs git init on branch main and makes an empty first commit.' }
    : { icon: 'i-lucide-git-commit-horizontal', color: 'text-info', text: 'Not a git repository yet. Runs git init on branch main; nothing is committed. Creating the first environment offers to commit what is here.' }
})

async function submit() {
  if (!repoPath.value.trim() || inspecting.value || state.value?.problem) return
  submitting.value = true
  try {
    const project = await $fetch<Project>('/api/projects', {
      method: 'POST',
      body: { name: name.value.trim() || undefined, repoPath: repoPath.value.trim(), initialize: initialize.value }
    })
    open.value = false
    toast.add({ title: 'Project added', color: 'success' })
    emit('created', project)
  } catch (error: any) {
    toast.add({
      title: 'Could not add project',
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
    title="New project"
    description="A git checkout on this machine, or a folder Domo makes into one. Its development environments each work on a branch of their own."
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Name" hint="Optional — defaults to the folder name">
          <UInput v-model="name" placeholder="Domo" class="w-full" autofocus />
        </UFormField>

        <UFormField label="Folder" :error="state?.problem ?? false">
          <DirectoryPicker
            v-model="repoPath"
            allow-new
            title="Choose the project folder"
            description="An existing checkout, any folder, or a new one inside the folder you are in."
            placeholder="~/code/my-project"
          />
          <template v-if="plan" #help>
            <span class="flex items-start gap-1.5 text-xs text-muted">
              <UIcon :name="plan.icon" class="mt-0.5 size-3.5 shrink-0" :class="plan.color" />
              <span>{{ plan.text }}</span>
            </span>
          </template>
        </UFormField>

        <UAlert
          v-if="state?.enclosingRepository && !state.problem"
          color="warning"
          variant="subtle"
          icon="i-lucide-folder-git-2"
          title="This is inside another git repository"
          :description="`${state.enclosingRepository} is a repository already. A project here would be a second repository nested inside it.`"
          :actions="[{ label: 'Use that repository', color: 'warning', variant: 'outline', onClick: () => { repoPath = state!.enclosingRepository! } }]"
        />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          :label="submitLabel"
          :icon="initialize ? 'i-lucide-folder-plus' : 'i-lucide-plus'"
          :loading="submitting"
          :disabled="!repoPath.trim() || inspecting || !!state?.problem"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
