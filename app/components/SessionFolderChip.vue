<script setup lang="ts">
import type { Project } from '~~/shared/types'

/**
 * Where a session works, as a chip named after its folder: a small menu with
 * the whole path, the project it belongs to, and a way to copy the path.
 */
const props = defineProps<{ path: string, project: Project | null }>()

const toast = useToast()

async function copy() {
  try {
    await navigator.clipboard.writeText(props.path)
    toast.add({ title: 'Path copied', description: props.path, color: 'neutral', icon: 'i-lucide-clipboard-check' })
  } catch {
    toast.add({ title: 'Could not copy the path', description: 'The browser did not allow it.', color: 'error' })
  }
}

const items = computed(() => [
  [{ type: 'label' as const, label: props.path }],
  [
    ...props.project ? [{ label: `Open ${props.project.name}`, icon: 'i-lucide-folder-git-2', to: `/projects/${props.project.id}` }] : [],
    { label: 'Copy path', icon: 'i-lucide-copy', onSelect: copy }
  ]
])
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'start' }" :ui="{ label: 'font-mono font-normal break-all' }">
    <UButton
      color="neutral"
      variant="soft"
      size="xs"
      :title="project ? `${path} · in ${project.name}` : path"
      :aria-label="`Folder ${path}`"
      class="max-w-48 shrink-0"
      :class="project ? '' : 'font-mono'"
      data-testid="folder-chip"
    >
      <template #leading>
        <UIcon :name="project ? 'i-lucide-folder-git-2' : 'i-lucide-folder'" class="size-3.5 shrink-0 text-dimmed" />
      </template>
      <span class="truncate">{{ project?.name ?? folderName(path) }}</span>
    </UButton>
  </UDropdownMenu>
</template>
