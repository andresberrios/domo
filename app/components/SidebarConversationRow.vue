<script setup lang="ts">
import type { VoiceSession } from '~~/shared/types'

const props = defineProps<{ session: VoiceSession }>()

const toast = useToast()
const busy = ref(false)
const renaming = ref(false)

async function patch(body: Record<string, unknown>, failure: string) {
  busy.value = true
  try {
    await $fetch(`/api/voice-sessions/${props.session.id}`, { method: 'PATCH', body })
  } catch (error: any) {
    toast.add({ title: failure, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}

async function rename(title: string) {
  renaming.value = false
  // A title typed here is the user's; the endpoint flips `title_source` so the
  // voice agent stops renaming it underneath them.
  await patch({ title }, 'Could not rename the conversation')
}

const items = computed(() => [[
  { label: 'Rename', icon: 'i-lucide-pencil', onSelect: () => { renaming.value = true } },
  { label: 'Let Domo name it', icon: 'i-lucide-sparkles', onSelect: () => patch({ autoTitle: true }, 'Could not hand naming back') },
  { label: 'Archive', icon: 'i-lucide-archive', onSelect: () => patch({ archived: true }, 'Could not archive the conversation') }
]])
</script>

<template>
  <div class="group flex items-center gap-1 rounded-md pe-1 hover:bg-elevated has-[a.row-active]:bg-elevated has-[a.row-active]:font-medium">
    <NuxtLink
      :to="`/voice/${session.id}`"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm"
      active-class="row-active"
    >
      <UIcon
        :name="session.status === 'live' ? 'i-lucide-radio' : 'i-lucide-message-circle'"
        class="size-4 shrink-0"
        :class="session.status === 'live' ? 'text-primary' : 'text-dimmed'"
      />
      <span class="min-w-0 flex-1 truncate">{{ session.title }}</span>
    </NuxtLink>

    <UDropdownMenu :items="items" :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-ellipsis"
        color="neutral"
        variant="ghost"
        size="xs"
        :loading="busy"
        :aria-label="`Actions for ${session.title}`"
        :class="ROW_ACTIONS_CLASS"
      />
    </UDropdownMenu>

    <RenameModal
      v-model:open="renaming"
      title="Rename conversation"
      description="Your title sticks — Domo stops renaming this conversation itself."
      :initial="session.title"
      @submit="rename"
    />
  </div>
</template>
