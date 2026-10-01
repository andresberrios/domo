<script setup lang="ts">
import { DEFAULT_AGENT_VOICE } from '~~/shared/agent-voice'

/**
 * Talking to a coding agent from its page: the voice bar's engines, voices,
 * language, turn detection and sounds. The live voice agent's settings stay
 * on General; the one they share is the Gemini voice, which is edited there.
 */
const toast = useToast()
const { data: settings, refresh } = await useSettingsForm()

const form = ref({ ...DEFAULT_AGENT_VOICE })
watchEffect(() => {
  // Copied rather than shared, so an edit left unsaved never looks saved.
  if (settings.value) form.value = { ...settings.value.agentVoice }
})

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { agentVoice: form.value } })
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
    <AgentVoiceSettings
      v-model="form"
      :gemini-voice="settings?.voiceName ?? 'Puck'"
      :has-gemini-key="settings?.hasGeminiKey"
      :has-open-ai-key="settings?.hasOpenAiKey"
    />
  </SettingsShell>
</template>
