<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

const props = defineProps<{ session: AgentSession }>()

const toast = useToast()
const text = ref('')
const sending = ref(false)
const uploading = ref(false)
const attachments = ref<Array<{ name: string, path: string, mimeType: string, size: number }>>([])
const fileInput = ref<HTMLInputElement | null>(null)

const busy = computed(() => props.session.status === 'thinking' || props.session.status === 'starting')
const status = computed(() => (busy.value ? ('streaming' as const) : ('ready' as const)))

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  if (!input.files?.length) return
  uploading.value = true
  try {
    const form = new FormData()
    for (const file of Array.from(input.files)) form.append('files', file)
    const result = await $fetch<{ files: typeof attachments.value }>('/api/uploads', {
      method: 'POST',
      body: form
    })
    attachments.value = [...attachments.value, ...result.files]
  } catch (error: any) {
    toast.add({ title: 'Upload failed', description: error?.message, color: 'error' })
  } finally {
    uploading.value = false
    input.value = ''
  }
}

function removeAttachment(path: string) {
  attachments.value = attachments.value.filter(attachment => attachment.path !== path)
}

async function submit() {
  const body = text.value.trim()
  if (!body && !attachments.value.length) return

  sending.value = true
  try {
    const content: any[] = []
    for (const attachment of attachments.value) {
      content.push({
        type: 'resource_link',
        uri: `file://${attachment.path}`,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size
      })
    }
    if (body) content.push({ type: 'text', text: body })

    await $fetch(`/api/agents/${props.session.id}/prompt`, { method: 'POST', body: { content } })
    text.value = ''
    attachments.value = []
  } catch (error: any) {
    toast.add({
      title: 'Could not send',
      description: error?.data?.statusMessage ?? error?.message,
      color: 'error'
    })
  } finally {
    sending.value = false
  }
}

async function stop() {
  try {
    await $fetch(`/api/agents/${props.session.id}/cancel`, { method: 'POST' })
  } catch (error: any) {
    toast.add({ title: 'Could not stop', description: error?.message, color: 'error' })
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-2">
    <div v-if="attachments.length" class="flex flex-wrap gap-1.5">
      <UBadge
        v-for="attachment in attachments"
        :key="attachment.path"
        color="neutral"
        variant="subtle"
        size="md"
        class="gap-1"
      >
        <UIcon name="i-lucide-paperclip" class="size-3" />
        {{ attachment.name }}
        <UButton
          icon="i-lucide-x"
          color="neutral"
          variant="link"
          size="xs"
          class="-me-1 p-0"
          @click="removeAttachment(attachment.path)"
        />
      </UBadge>
    </div>

    <UChatPrompt
      v-model="text"
      :placeholder="busy ? 'The agent is working — type to queue a follow-up…' : 'Message this agent…'"
      :autoresize="true"
      :maxrows="10"
      variant="outline"
      @submit="submit"
    >
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <div class="flex items-center gap-1">
            <UTooltip text="Attach files">
              <UButton
                icon="i-lucide-paperclip"
                color="neutral"
                variant="ghost"
                size="sm"
                :loading="uploading"
                @click="fileInput?.click()"
              />
            </UTooltip>
            <input
              ref="fileInput"
              type="file"
              multiple
              class="hidden"
              @change="onFiles"
            >
            <span class="hidden text-xs text-dimmed sm:inline">
              {{ shortPath(session.cwd, 3) }}
            </span>
          </div>

          <UChatPromptSubmit
            :status="status"
            :loading="sending"
            @stop="stop"
            @reload="submit"
          />
        </div>
      </template>
    </UChatPrompt>
  </div>
</template>
