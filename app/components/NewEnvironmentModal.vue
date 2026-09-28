<script setup lang="ts">
import type { DevEnvironment, Project, RepositoryState, WorkspaceSeedReport } from '~~/shared/types'

/**
 * A new dev environment for one project. Shared by the sidebar's per-project
 * plus button and the project details page, so there is one form and one
 * description of what creation actually costs.
 */
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ project: Project | null }>()
const emit = defineEmits<{ created: [environment: DevEnvironment] }>()

const toast = useToast()
const name = ref('')
const submitting = ref(false)
const repository = ref<RepositoryState | null>(null)
const committing = ref(false)

/** A worktree is cut from a commit, so a project without one is offered its first before anything else. */
async function readRepository() {
  repository.value = null
  if (!props.project) return
  repository.value = await $fetch<RepositoryState>(`/api/projects/${props.project.id}/repository`).catch(() => null)
}

watch([open, () => props.project?.id], ([isOpen]) => {
  if (!isOpen) return
  name.value = ''
  readRepository()
}, { immediate: true })

const needsFirstCommit = computed(() => !!repository.value && !repository.value.hasCommits)

async function createFirstCommit() {
  if (!props.project) return
  committing.value = true
  try {
    await $fetch(`/api/projects/${props.project.id}/initial-commit`, { method: 'POST' })
    await readRepository()
  } catch (error: any) {
    toast.add({
      title: 'Could not create the first commit',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    committing.value = false
  }
}

/** How the worktree started, for the toast. */
function seedDescription(seed: WorkspaceSeedReport | undefined): string {
  if (!seed) return 'It starts from your last commit.'
  const parts = [seed.total
    ? `It starts from your last commit; ${seed.total} uncommitted ${seed.total === 1 ? 'path stays' : 'paths stay'} on your machine.`
    : 'It starts from your last commit.']
  if (seed.copied.length) parts.push(`Copied ${seed.copied.join(', ')}.`)
  if (seed.install?.error) parts.push(`\`${seed.install.command}\` failed: ${seed.install.error}`)
  return parts.join(' ')
}

async function submit() {
  const value = name.value.trim()
  if (!value || !props.project || needsFirstCommit.value) return
  submitting.value = true
  try {
    const environment = await $fetch<DevEnvironment & { workspaceSeed?: WorkspaceSeedReport }>(
      '/api/dev-environments',
      { method: 'POST', body: { projectId: props.project.id, name: value } }
    )
    open.value = false
    toast.add({
      title: `${value} is ready`,
      description: seedDescription(environment.workspaceSeed),
      color: environment.workspaceSeed?.install?.error ? 'warning' : 'success'
    })
    emit('created', environment)
  } catch (error: any) {
    toast.add({
      title: 'Could not create environment',
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
    title="New development environment"
    :description="project
      ? `A container of its own for ${project.name}, with its own git worktree starting from your last commit.`
      : 'A container of its own, with its own git worktree of the project.'"
  >
    <template #body>
      <UAlert
        v-if="needsFirstCommit"
        class="mb-4"
        color="warning"
        variant="subtle"
        icon="i-lucide-git-commit-horizontal"
        title="This project has no commits yet"
        :description="repository?.repository
          ? `An environment starts from a commit. Domo can commit everything in the project${repository.filesToCommit !== null ? ` (${repository.filesToCommit} ${repository.filesToCommit === 1 ? 'file' : 'files'}, respecting .gitignore)` : ''} as the first one.`
          : 'An environment starts from a commit. Domo can make this folder a git repository and commit everything in it as the first one.'"
        :actions="[{ label: 'Create first commit', color: 'warning', loading: committing, onClick: createFirstCommit }]"
      />
      <UFormField label="Name" hint="Also names the branch you will work on">
        <UInput
          v-model="name"
          placeholder="feature-auth"
          class="w-full"
          autofocus
          @keyup.enter="submit"
        />
      </UFormField>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          label="Create environment"
          icon="i-lucide-monitor"
          :loading="submitting"
          :disabled="!name.trim() || !project || needsFirstCommit"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
