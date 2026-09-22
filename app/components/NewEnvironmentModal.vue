<script setup lang="ts">
import type { DevEnvironment, Project } from '~~/shared/types'

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

watch(open, (isOpen) => {
  if (isOpen) name.value = ''
})

async function submit() {
  const value = name.value.trim()
  if (!value || !props.project) return
  submitting.value = true
  try {
    const environment = await $fetch<DevEnvironment>('/api/dev-environments', {
      method: 'POST',
      body: { projectId: props.project.id, name: value }
    })
    open.value = false
    toast.add({
      title: `${value} is ready`,
      description: 'The repository was copied into its container.',
      color: 'success'
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
      ? `A container of its own for ${project.name}, with a private copy of the checkout. Creating it copies the repository, which takes a moment.`
      : 'A container of its own, with a private copy of the checkout.'"
  >
    <template #body>
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
          :disabled="!name.trim() || !project"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
