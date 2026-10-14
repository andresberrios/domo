<script setup lang="ts">
import type { Project } from '~~/shared/types'

/**
 * Adding a project is now a sidebar action, so the form lives in the modal
 * rather than on a page. One implementation: the project details page links
 * back here too.
 */
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [project: Project] }>()

const toast = useToast()
const name = ref('')
const repoPath = ref('')
const submitting = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = ''
  repoPath.value = ''
})

async function submit() {
  if (!repoPath.value.trim()) return
  submitting.value = true
  try {
    const project = await $fetch<Project>('/api/projects', {
      method: 'POST',
      body: { name: name.value.trim() || undefined, repoPath: repoPath.value.trim() }
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
    description="Points Domo at a git checkout on this machine. Its development environments each work on a branch of their own."
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Name" hint="Optional — defaults to the directory name">
          <UInput v-model="name" placeholder="Domo" class="w-full" autofocus />
        </UFormField>

        <UFormField label="Repository">
          <DirectoryPicker v-model="repoPath" />
          <template #help>
            <span class="text-xs text-muted">
              The checkout stays where it is. Environments share its branches and commits, so a branch an agent makes in one shows up here at once.
            </span>
          </template>
        </UFormField>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" color="neutral" variant="ghost" @click="open = false" />
        <UButton
          label="Add project"
          icon="i-lucide-plus"
          :loading="submitting"
          :disabled="!repoPath.trim()"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
