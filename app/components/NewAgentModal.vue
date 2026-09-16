<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{ voiceSessionId?: string | null }>()

const router = useRouter()
const toast = useToast()

const title = ref('')
const cwd = ref('')
const task = ref('')
const submitting = ref(false)

const { data: settings } = await useFetch('/api/settings', { lazy: true })

watch(open, async (value) => {
  if (!value) return
  title.value = ''
  task.value = ''
  cwd.value = settings.value?.defaultCwd ?? ''
})

async function create() {
  if (!title.value.trim() && !task.value.trim()) return
  submitting.value = true
  try {
    const session = await $fetch<{ id: string }>('/api/agents', {
      method: 'POST',
      body: {
        title: title.value.trim() || task.value.trim().slice(0, 60),
        cwd: cwd.value.trim() || undefined,
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
    description="Starts a Claude Code session over ACP in the directory you choose."
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Name" hint="How you'll refer to it out loud">
          <UInput v-model="title" placeholder="auth refactor" class="w-full" autofocus />
        </UFormField>

        <UFormField label="Working directory">
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
