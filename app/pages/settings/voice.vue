<script setup lang="ts">
import { DEFAULT_AGENT_VOICE } from '~~/shared/agent-voice'

/**
 * Talking to a coding agent from its page: the voice bar's engines, voices,
 * language, turn detection and sounds.
 */
const toast = useToast()
const { data: settings, refresh } = await useSettingsForm()

const form = ref({ ...DEFAULT_AGENT_VOICE })
watchEffect(() => {
  // Copied rather than shared, so an edit left unsaved never looks saved.
  if (settings.value) form.value = { ...settings.value.agentVoice }
})

/**
 * Which assistant Talk opens. Reka's select items may not have an empty-string
 * value, so "the most recent one" is a named sentinel rather than ''.
 */
const MOST_RECENT = 'most-recent'
const { assistants } = useAssistants()
const talkTarget = ref(MOST_RECENT)
watchEffect(() => {
  if (settings.value) talkTarget.value = settings.value.defaultAssistantId || MOST_RECENT
})
const talkItems = computed(() => [
  { label: 'The assistant you talked to last', value: MOST_RECENT },
  ...assistants.value.filter(assistant => !assistant.archived).map(assistant => ({
    label: assistant.name,
    value: assistant.id,
    avatar: { src: assistant.avatar ?? undefined, alt: assistant.name }
  }))
])

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: {
      agentVoice: form.value,
      defaultAssistantId: talkTarget.value === MOST_RECENT ? '' : talkTarget.value
    } })
    await refresh()
    toast.add({ title: 'Settings saved', color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: 'Could not save', description: error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsShell
    title="Talking to agents"
    description="The voice bar on an agent's page. One engine hears you, one speaks the agent's replies; the agent itself does the thinking. The bar's own settings button changes the common ones on the spot."
    :saving="saving"
    :save="save"
  >
    <UFormField
      label="Talk opens"
      description="The Talk button opens this assistant with the voice bar on. With no assistant at all, it starts a fresh session instead."
    >
      <USelect v-model="talkTarget" :items="talkItems" value-key="value" class="w-full sm:w-80" />
    </UFormField>
    <AgentVoiceSettings
      v-model="form"
      :has-gemini-key="settings?.hasGeminiKey"
      :has-open-ai-key="settings?.hasOpenAiKey"
    />
  </SettingsShell>
</template>
