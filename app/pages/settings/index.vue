<script setup lang="ts">
import type { AppSettings } from '~~/shared/types'

const toast = useToast()
const { data: settings, refresh } = await useFetch<AppSettings & {
  hasGeminiKey: boolean
  hasAnthropicKey: boolean
  hasOpenAiKey: boolean
  hasOpenCodeAuth: boolean
}>('/api/settings')
const { data: modelList } = await useFetch<{
  models: Array<{ name: string, displayName?: string, live: boolean }>
  error?: string
}>('/api/models', { lazy: true })

const form = reactive({
  liveModel: '',
  voiceName: 'Puck',
  systemInstruction: '',
  proactiveNotifications: true,
  language: 'en-US',
  autoTitle: true
})

watchEffect(() => {
  if (!settings.value) return
  Object.assign(form, {
    liveModel: settings.value.liveModel,
    voiceName: settings.value.voiceName,
    systemInstruction: settings.value.systemInstruction,
    proactiveNotifications: settings.value.proactiveNotifications,
    language: settings.value.language,
    autoTitle: settings.value.autoTitle
  })
})

const modelItems = computed(() => {
  const fromApi = (modelList.value?.models ?? []).filter(model => model.live).map(model => model.name)
  return [...new Set([form.liveModel, ...fromApi].filter(Boolean))]
})
const voices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']
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
          :color="settings?.hasOpenCodeAuth ? 'success' : 'neutral'"
          variant="subtle"
          icon="i-lucide-code-xml"
          title="OpenCode"
          :description="settings?.hasOpenCodeAuth ? 'Auth store configured' : 'Run opencode auth login'"
        />
      </div>
    </section>

    <USeparator />

    <section class="space-y-4">
      <h2 class="text-sm font-semibold">Voice agent</h2>
      <UFormField label="Live model" hint="Gemini Live model id">
        <UInputMenu v-model="form.liveModel" :items="modelItems" create-item class="w-full font-mono text-xs" @create="value => (form.liveModel = value)" />
        <template #help>
          <span v-if="modelList?.error" class="text-xs text-muted">Could not list models: {{ modelList.error }} — type the id manually.</span>
        </template>
      </UFormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Voice"><USelectMenu v-model="form.voiceName" :items="voices" class="w-full" /></UFormField>
        <UFormField label="Spoken language"><UInput v-model="form.language" class="w-full" placeholder="en-US" /></UFormField>
      </div>
      <UFormField label="System instruction" hint="How the voice agent behaves">
        <UTextarea v-model="form.systemInstruction" :rows="10" class="w-full text-xs" />
      </UFormField>
      <USwitch v-model="form.proactiveNotifications" label="Speak up on agent activity" description="When a coding agent finishes a turn or needs a decision, the voice agent tells you." />
      <USwitch v-model="form.autoTitle" label="Name conversations automatically" description="The voice agent titles each conversation as it goes. A title you set yourself is never replaced." />
    </section>
  </SettingsShell>
</template>
