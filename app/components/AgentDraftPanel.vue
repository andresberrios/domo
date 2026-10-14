<script setup lang="ts">
import type { AgentDraft } from '~~/shared/types'

/**
 * Where a new session works, and what it is called: the part of starting one
 * the composer has no place for. The harness, model and mode are in the
 * composer's own settings card, as they are on any session; this panel sits
 * above it on the new-session page and goes away once the first message has
 * made the session.
 *
 * The project comes first and everything below it follows from it — which
 * environments are offered, where a host session's directory defaults to.
 */
const draft = defineModel<AgentDraft>({ required: true })
defineProps<{ disabled?: boolean }>()

const { projects } = useProjects()
const { environments } = useDevEnvironments()
const { data: settings } = useSettings()

// Reka's select items may not have an empty-string value, so neither "no
// project" nor "on this machine" can be ''.
const NO_PROJECT = 'no-project'
const LOCAL = 'local'

const projectItems = computed(() => [
  ...projects.value.map(project => ({ label: project.name, value: project.id, icon: 'i-lucide-folder-git-2' })),
  { label: 'No project', value: NO_PROJECT, icon: 'i-lucide-folder' }
])

const project = computed(() => projects.value.find(item => item.id === draft.value.projectId) ?? null)

/**
 * Where to run, *within* the chosen project: its checkout on the host, or one
 * of its containers. An environment always belongs to a project, so with none
 * chosen there is nothing to list and the panel asks for a path instead.
 */
const whereItems = computed(() => [
  { label: 'Local checkout', value: LOCAL, icon: 'i-lucide-laptop' },
  ...environments.value
    .filter(environment => environment.projectId === draft.value.projectId)
    .map(environment => ({ label: environment.name, value: environment.id, icon: 'i-lucide-monitor' }))
])

const projectChoice = computed({
  get: () => draft.value.projectId ?? NO_PROJECT,
  set: (value: string) => {
    const projectId = value === NO_PROJECT ? null : value
    if (projectId === draft.value.projectId) return
    // Changing the project re-points everything under it.
    draft.value = {
      ...draft.value,
      projectId,
      devEnvironmentId: null,
      cwd: defaultDraftCwd(projects.value, projectId, settings.value?.defaultCwd)
    }
  }
})

const whereChoice = computed({
  get: () => draft.value.devEnvironmentId ?? LOCAL,
  set: (value: string) => {
    draft.value = { ...draft.value, devEnvironmentId: value === LOCAL ? null : value }
  }
})

const cwd = computed({
  get: () => draft.value.cwd,
  set: (value: string) => { draft.value = { ...draft.value, cwd: value } }
})

const title = computed({
  get: () => draft.value.title,
  set: (value: string) => { draft.value = { ...draft.value, title: value } }
})

// Settings are fetched lazily and may land after the page is open.
watch(() => settings.value?.defaultCwd, (defaultCwd) => {
  if (defaultCwd && !draft.value.cwd) draft.value = { ...draft.value, cwd: defaultDraftCwd(projects.value, draft.value.projectId, defaultCwd) }
})
</script>

<template>
  <fieldset
    :disabled="disabled"
    class="mx-auto grid w-full max-w-3xl gap-3 rounded-lg border border-default bg-elevated/40 p-3 sm:grid-cols-2"
  >
    <legend class="sr-only">Where the new session works</legend>

    <UFormField label="Project" size="sm">
      <ChoiceMenu
        v-model="projectChoice"
        :items="projectItems"
        value-key="value"
        size="sm"
        class="w-full"
        :disabled="disabled"
      />
    </UFormField>

    <UFormField v-if="project" label="Where" size="sm">
      <ChoiceMenu
        v-model="whereChoice"
        :items="whereItems"
        value-key="value"
        size="sm"
        class="w-full"
        :disabled="disabled"
      />
    </UFormField>

    <UFormField v-if="!draft.devEnvironmentId" label="Working directory" size="sm">
      <DirectoryPicker v-model="cwd" />
    </UFormField>

    <!-- Across the row when it would otherwise sit alone on it. -->
    <UFormField label="Name" size="sm" hint="Optional" :class="project && !draft.devEnvironmentId ? '' : 'sm:col-span-2'">
      <UInput
        v-model="title"
        size="sm"
        placeholder="Named by its first message"
        class="w-full"
        :disabled="disabled"
      />
    </UFormField>
  </fieldset>
</template>
