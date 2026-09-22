<script setup lang="ts">
import type { Project } from '~~/shared/types'

/**
 * One project in the tree. Same split as an environment row: the name links to
 * the project's page, the chevron only opens its environments.
 */
const props = defineProps<{
  project: Project
  expanded: boolean
  agentCount: number
  environmentCount: number
}>()

const emit = defineEmits<{ toggle: [], newEnvironment: [] }>()

const toast = useToast()
const busy = ref(false)
const renaming = ref(false)
const confirmingRetire = ref(false)

async function rename(name: string) {
  renaming.value = false
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.project.id}`, { method: 'PATCH', body: { name } })
  } catch (error: any) {
    toast.add({ title: 'Could not rename the project', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

async function retire() {
  confirmingRetire.value = false
  busy.value = true
  try {
    await $fetch(`/api/projects/${props.project.id}`, { method: 'DELETE' })
    toast.add({ title: `${props.project.name} deleted`, color: 'neutral' })
  } catch (error: any) {
    toast.add({ title: 'Could not delete the project', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

const cascade = computed(() => {
  const environments = props.environmentCount === 1 ? '1 development environment' : `${props.environmentCount} development environments`
  const agents = props.agentCount === 1 ? '1 coding agent session' : `${props.agentCount} coding agent sessions`
  return `Destroys ${environments}: each container, its copy of the checkout and any Docker-in-Docker volume. `
    + `The records are kept — this project, those environments and ${agents} inside them stay readable — but those `
    + `agents can never be started again. The checkout at ${props.project.repoPath} is left alone; anything only `
    + 'inside an environment is lost.'
})

const items = computed(() => [
  [
    { label: 'New environment', icon: 'i-lucide-monitor', onSelect: () => emit('newEnvironment') },
    { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } }
  ],
  [
    { label: 'Retire', icon: 'i-lucide-box', color: 'error' as const, onSelect: () => { confirmingRetire.value = true } }
  ]
])
</script>

<template>
  <div class="group flex items-center gap-0.5 rounded-md pe-1 font-medium hover:bg-elevated has-[a.row-active]:bg-elevated has-[a.row-active]:font-semibold">
    <UButton
      icon="i-lucide-chevron-right"
      color="neutral"
      variant="ghost"
      size="xs"
      class="shrink-0"
      :ui="{ leadingIcon: ['transition-transform', expanded ? 'rotate-90' : ''] }"
      :aria-expanded="expanded"
      :aria-label="expanded ? `Collapse ${project.name}` : `Expand ${project.name}`"
      @click="emit('toggle')"
    />

    <NuxtLink
      :to="`/projects/${project.id}`"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-sm"
      active-class="row-active"
    >
      <UIcon name="i-lucide-folder-git-2" class="size-4 shrink-0 text-primary" />
      <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
    </NuxtLink>

    <UBadge
      v-if="agentCount"
      size="sm"
      color="neutral"
      variant="subtle"
      :label="agentCount"
      :class="ROW_BADGE_CLASS"
    />

    <UButton
      icon="i-lucide-plus"
      color="neutral"
      variant="ghost"
      size="xs"
      :aria-label="`New environment in ${project.name}`"
      :class="ROW_ACTIONS_CLASS"
      @click="emit('newEnvironment')"
    />

    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        size="xs"
        :loading="busy"
        :aria-label="`Actions for ${project.name}`"
        :class="ROW_ACTIONS_CLASS"
      />
    </UDropdownMenu>

    <RenameModal
      v-model:open="renaming"
      title="Rename project"
      description="Changes the name shown in Domo. The checkout on disk is not touched."
      :initial="project.name"
      @submit="rename"
    />

    <ConfirmModal
      v-model:open="confirmingRetire"
      :title="`Retire ${project.name}?`"
      :description="cascade"
      confirm-label="Retire project"
      :loading="busy"
      @confirm="retire"
    />
  </div>
</template>
