<script setup lang="ts">
import { DEFAULT_AGENT_VOICE, usesKyutai } from '~~/shared/agent-voice'

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

/**
 * The keys voice uses, beside the engines that use them. Gemini's always:
 * its engines are the default and nothing else uses it. OpenAI's and Kyutai's
 * only while one of their engines is chosen; the OpenAI key is also Codex's
 * and OpenCode's, on their pages.
 */
const usesOpenAi = computed(() => form.value.transcriber === 'openai' || form.value.speaker === 'openai')
const showKyutaiKey = computed(() => usesKyutai(form.value))

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
    toast.add({ title: 'Could not save', description: error?.data?.message ?? error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <SettingsShell
    title="Voice"
    description="Voice mode in an agent's composer (the microphone beside Send). One engine hears you, one speaks the agent's replies; the agent itself does the thinking. Its own settings button changes the common ones on the spot."
    :saving="saving"
    :save="save"
  >
    <UFormField
      label="Talk opens"
      description="The Talk button opens this assistant in voice mode. With no assistant at all, it starts a fresh session instead."
    >
      <USelect v-model="talkTarget" :items="talkItems" value-key="value" class="w-full sm:w-80" />
    </UFormField>
    <section class="space-y-4">
      <div>
        <h2 class="text-sm font-semibold">Keys</h2>
        <p class="text-xs text-muted">Saved on the server and never sent back to the browser. The open models and this device's own voices need none.</p>
      </div>
      <CredentialField
        :settings="settings ?? null"
        credential="geminiApiKey"
        label="Gemini API key"
        placeholder="AIza…"
        @saved="refresh"
      >
        <template #help>
          For the Gemini engines.
          <ULink to="https://aistudio.google.com/apikey" target="_blank" class="text-primary">Get a key at Google AI Studio</ULink>.
        </template>
      </CredentialField>
      <CredentialField
        v-if="usesOpenAi"
        :settings="settings ?? null"
        credential="openAiApiKey"
        label="OpenAI API key"
        help="For the OpenAI engines. Codex and OpenCode can use the same key."
        placeholder="sk-…"
        warning="Bills per token through the OpenAI API, not a ChatGPT plan."
        @saved="refresh"
      />
      <CredentialField
        v-if="showKyutaiKey"
        :settings="settings ?? null"
        credential="kyutaiApiKey"
        label="Kyutai server key"
        help="Only if your Kyutai server asks for one."
        placeholder="Key"
        @saved="refresh"
      />
    </section>
    <USeparator />
    <AgentVoiceSettings
      v-model="form"
      :has-gemini-key="settings?.hasGeminiKey"
      :has-open-ai-key="settings?.hasOpenAiKey"
    />
  </SettingsShell>
</template>
