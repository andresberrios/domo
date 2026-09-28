<script setup lang="ts">
import type { AppSettings } from '~~/shared/types'
import { DEFAULT_VOICE_DELEGATION, DEFAULT_OPENAI_LIVE_MODEL, DEFAULT_OPENAI_VOICE } from '~~/shared/voice-providers'

const toast = useToast()
const { data: settings, refresh } = await useSettingsForm()
/**
 * OpenCode has two credentials that do different jobs, and one being present
 * says nothing about the other: a host login runs host sessions and is all
 * OpenCode needs there, while a console key is the only thing a container
 * session or the plan-limit poll can use.
 */
const openCodeAuthSummary = computed(() => {
  const key = settings.value?.hasOpenCodeKey
  const login = settings.value?.hasOpenCodeAuth
  if (key && login) return 'Console key and host login'
  if (key) return 'Console key configured'
  if (login) return 'Host login only — add a console key for environments'
  return 'Run opencode auth login, or add a console key'
})

const form = reactive({
  voiceProvider: 'gemini' as AppSettings['voiceProvider'],
  liveModel: '',
  voiceName: 'Puck',
  openaiLiveModel: DEFAULT_OPENAI_LIVE_MODEL,
  openaiVoiceName: DEFAULT_OPENAI_VOICE,
  openaiDelegation: { ...DEFAULT_VOICE_DELEGATION },
  systemInstruction: '',
  proactiveNotifications: true,
  language: 'en-US',
  autoTitle: true
})

watchEffect(() => {
  if (!settings.value) return
  Object.assign(form, {
    voiceProvider: settings.value.voiceProvider,
    liveModel: settings.value.liveModel,
    voiceName: settings.value.voiceName,
    openaiLiveModel: settings.value.openaiLiveModel,
    openaiVoiceName: settings.value.openaiVoiceName,
    // Copied rather than shared: the form is written in place by the voice
    // card, and mutating the fetched settings object would make a cancelled
    // edit look saved.
    openaiDelegation: { ...settings.value.openaiDelegation },
    systemInstruction: settings.value.systemInstruction,
    proactiveNotifications: settings.value.proactiveNotifications,
    language: settings.value.language,
    autoTitle: settings.value.autoTitle
  })
})

const saving = ref(false)

async function save() {
  saving.value = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: form })
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
    title="General"
    description="Voice-agent behavior, model and credentials."
    :saving="saving"
    :save="save"
  >
    <section class="space-y-3">
      <div>
        <h2 class="text-sm font-semibold">Credentials</h2>
        <p class="text-xs text-muted">Keys come from your <code class="rounded bg-elevated px-1">.env</code> file, never the database.</p>
      </div>
      <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <UAlert
          :color="settings?.hasGeminiKey ? 'success' : 'warning'"
          variant="subtle"
          :icon="settings?.hasGeminiKey ? 'i-lucide-check' : 'i-lucide-key-round'"
          title="Gemini"
          :description="settings?.hasGeminiKey ? 'Voice key configured' : 'Set NUXT_GEMINI_API_KEY'"
        />
        <UAlert
          :color="settings?.hasAnthropicKey ? 'success' : 'neutral'"
          variant="subtle"
          icon="i-lucide-sparkles"
          title="Anthropic"
          :description="settings?.hasAnthropicKey ? 'API key configured' : 'Local login or setup token'"
        />
        <UAlert
          :color="settings?.hasOpenAiKey ? 'success' : 'neutral'"
          variant="subtle"
          icon="i-lucide-terminal"
          title="OpenAI"
          :description="settings?.hasOpenAiKey ? 'API key configured' : 'Local login may be used'"
        />
        <UAlert
          :color="settings?.hasOpenCodeKey || settings?.hasOpenCodeAuth ? 'success' : 'neutral'"
          variant="subtle"
          icon="i-lucide-code-xml"
          title="OpenCode"
          :description="openCodeAuthSummary"
        />
      </div>
    </section>

    <USeparator />

    <section class="space-y-4">
      <h2 class="text-sm font-semibold">Voice agent</h2>
      <VoiceProviderSettings
        v-model="form"
        :has-gemini-key="settings?.hasGeminiKey"
        :has-open-ai-key="settings?.hasOpenAiKey"
      />
      <UFormField label="System instruction" hint="How the voice agent behaves">
        <UTextarea v-model="form.systemInstruction" :rows="10" class="w-full text-xs" />
      </UFormField>
      <USwitch v-model="form.proactiveNotifications" label="Speak up on agent activity" description="When a coding agent finishes a turn or needs a decision, the voice agent tells you." />
      <USwitch v-model="form.autoTitle" label="Name conversations automatically" description="The voice agent titles each conversation as it goes. A title you set yourself is never replaced." />
    </section>
  </SettingsShell>
</template>
