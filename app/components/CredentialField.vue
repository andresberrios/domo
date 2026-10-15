<script setup lang="ts">
import type { AppSettingsView, SecretSettingKey } from '~~/shared/types'

/**
 * One credential, write-only on purpose: `GET /api/settings` answers where
 * each comes from and never its value, so the box starts empty whether or not
 * one is saved, and only a typed value is ever sent. Removal is its own
 * action. One set by the server's configuration cannot be changed here.
 */
const props = defineProps<{
  settings: AppSettingsView | null
  credential: SecretSettingKey
  label: string
  help?: string
  placeholder: string
  /** What using it costs, always shown beside it. */
  warning?: string
}>()
const emit = defineEmits<{ saved: [] }>()
const toast = useToast()

const draft = ref('')
const busy = ref(false)
const source = computed(() => props.settings?.credentialSources?.[props.credential] ?? null)

async function write(value: string) {
  busy.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { [props.credential]: value } })
    draft.value = ''
    emit('saved')
    toast.add({ title: value ? `${props.label} saved` : `${props.label} removed`, color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: `Could not ${value ? 'save' : 'remove'} the ${props.label.toLowerCase()}`, description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UFormField :label="label" :help="help">
    <template v-if="$slots.help" #help>
      <slot name="help" />
    </template>
    <div v-if="source === 'server'" class="flex items-center gap-2 rounded-md border border-default px-3 py-1.5 text-sm text-muted">
      <UIcon name="i-lucide-lock" class="size-4 shrink-0" />
      Set by the server's configuration
    </div>
    <div v-else class="flex flex-wrap items-center gap-2">
      <UInput
        v-model="draft"
        type="password"
        class="min-w-0 flex-1 basis-48"
        autocomplete="off"
        :placeholder="source ? 'Saved — type a new one to replace it' : placeholder"
        @keydown.enter="draft.trim() && write(draft.trim())"
      />
      <div class="flex gap-2">
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-save"
          :disabled="!draft.trim()"
          :loading="busy"
          @click="write(draft.trim())"
        >
          Save
        </UButton>
        <UButton
          v-if="source"
          color="neutral"
          variant="subtle"
          icon="i-lucide-trash-2"
          :loading="busy"
          @click="write('')"
        >
          Remove
        </UButton>
      </div>
    </div>
    <UAlert
      v-if="warning"
      class="mt-2"
      color="warning"
      variant="subtle"
      icon="i-lucide-receipt"
      :description="warning"
    />
  </UFormField>
</template>
