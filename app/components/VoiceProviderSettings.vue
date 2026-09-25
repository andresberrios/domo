<script setup lang="ts">
import type { AgentAdapter, VoiceDelegationSettings, VoiceProvider } from '~~/shared/types'
import { AGENT_ADAPTERS } from '~~/shared/agent-adapters'
import {
  GEMINI_VOICES,
  OPENAI_VOICES,
  REASONING_EFFORTS,
  VOICE_PROVIDERS
} from '~~/shared/voice-providers'

/**
 * Which live voice model runs conversations, and how it is set up.
 *
 * The two providers are not two spellings of one thing, so this is not one
 * form with a vendor dropdown on top: Gemini takes a model, a voice and a
 * spoken language and does the thinking itself, while GPT-Live takes a model
 * and a voice and then has to be told *who thinks* — an OpenAI text model it
 * calls for you, or one of your own coding agents. Only the chosen provider's
 * fields are shown, because a field that does nothing is worse than a missing
 * one; both are still saved, so switching back finds the old setup intact.
 */

export interface VoiceFormState {
  voiceProvider: VoiceProvider
  liveModel: string
  voiceName: string
  language: string
  openaiLiveModel: string
  openaiVoiceName: string
  openaiDelegation: VoiceDelegationSettings
}

/**
 * The settings page's own form object, written in place. A model rather than a
 * prop because these fields are the card's whole purpose; the page keeps one
 * `reactive` form and submits it whole.
 */
const form = defineModel<VoiceFormState>({ required: true })

defineProps<{
  hasGeminiKey?: boolean
  hasOpenAiKey?: boolean
}>()

const { data: geminiModels } = await useFetch<{
  models: Array<{ name: string, live: boolean }>
  error?: string
}>('/api/models', { lazy: true })

/**
 * Asked for only once the OpenAI side is on screen. Listing models costs a
 * round trip to a second vendor, and an install running Gemini has no reason
 * to pay for it — the same "do not probe until the panel is open" rule the
 * agent composer's model picker follows.
 */
const { data: openAiModels, execute: loadOpenAiModels } = await useFetch<{
  models: Array<{ id: string, live: boolean }>
  error?: string
}>('/api/openai-models', { lazy: true, immediate: false })

let askedOpenAi = false
watch(() => form.value.voiceProvider, (provider) => {
  if (provider !== 'openai' || askedOpenAi) return
  askedOpenAi = true
  void loadOpenAiModels()
}, { immediate: true, flush: 'post' })

const { sessions } = useAgentSessions()
const { environments } = useDevEnvironments()

const geminiModelItems = computed(() => {
  const listed = (geminiModels.value?.models ?? []).filter(model => model.live).map(model => model.name)
  return [...new Set([form.value.liveModel, ...listed].filter(Boolean))]
})
const openAiLiveItems = computed(() => {
  const listed = (openAiModels.value?.models ?? []).filter(model => model.live).map(model => model.id)
  return [...new Set([form.value.openaiLiveModel, ...listed].filter(Boolean))]
})
const responsesModelItems = computed(() => {
  // Every model the key can see except the live ones: a voice model cannot be
  // the thing a voice model delegates to.
  const listed = (openAiModels.value?.models ?? []).filter(model => !model.live).map(model => model.id)
  return [...new Set([form.value.openaiDelegation.responsesModel, ...listed].filter(Boolean))]
})

const effortItems = REASONING_EFFORTS.map(value => ({
  value,
  label: value || 'Model default'
}))

const adapterItems = AGENT_ADAPTERS.map(adapter => ({ value: adapter.id as AgentAdapter, label: adapter.label }))

/** A named session, or the sentinel that means "make one when it is first needed". */
const AUTOMATIC = '__automatic__'
const NO_ENVIRONMENT = '__none__'

const agentItems = computed(() => [
  { value: AUTOMATIC, label: 'Create one automatically' },
  ...sessions.value.map(session => ({ value: session.id, label: session.title }))
])

const environmentItems = computed(() => [
  { value: NO_ENVIRONMENT, label: 'Default workspace directory' },
  ...environments.value
    .filter(environment => !environment.retiredAt)
    .map(environment => ({ value: environment.id, label: environment.name }))
])

// Reka select items cannot have `value: ''` — it throws when the menu opens —
// so "none" is a named sentinel on the way in and an empty string on the way
// out, which is what the settings row stores.
const agentChoice = computed({
  get: () => form.value.openaiDelegation.agentSessionId || AUTOMATIC,
  set: (value: string) => {
    form.value.openaiDelegation.agentSessionId = value === AUTOMATIC ? '' : value
  }
})
const environmentChoice = computed({
  get: () => form.value.openaiDelegation.agentDevEnvironmentId || NO_ENVIRONMENT,
  set: (value: string) => {
    form.value.openaiDelegation.agentDevEnvironmentId = value === NO_ENVIRONMENT ? '' : value
  }
})
</script>

<template>
  <div class="space-y-4">
    <UFormField label="Voice model" hint="Which live model runs conversations">
      <div class="grid gap-2 sm:grid-cols-2">
        <button
          v-for="provider in VOICE_PROVIDERS"
          :key="provider.id"
          type="button"
          class="flex items-start gap-2 rounded-lg border p-3 text-left transition-colors"
          :class="form.voiceProvider === provider.id
            ? 'border-primary bg-elevated'
            : 'border-default hover:bg-elevated/50'"
          :aria-pressed="form.voiceProvider === provider.id"
          @click="form.voiceProvider = provider.id"
        >
          <UIcon :name="provider.icon" class="mt-0.5 size-4 shrink-0" />
          <span class="space-y-0.5">
            <span class="block text-sm font-medium">{{ provider.label }}</span>
            <span class="block text-xs text-muted">{{ provider.description }}</span>
          </span>
        </button>
      </div>
    </UFormField>

    <UAlert
      v-if="form.voiceProvider === 'gemini' && hasGeminiKey === false"
      color="warning"
      variant="subtle"
      icon="i-lucide-key-round"
      title="No Gemini API key"
      description="Set NUXT_GEMINI_API_KEY in .env and restart the server, or switch to GPT-Live."
    />
    <UAlert
      v-if="form.voiceProvider === 'openai' && hasOpenAiKey === false"
      color="warning"
      variant="subtle"
      icon="i-lucide-key-round"
      title="No OpenAI API key"
      description="Set NUXT_OPENAI_API_KEY in .env and restart the server, or switch to Gemini Live."
    />

    <template v-if="form.voiceProvider === 'gemini'">
      <UFormField label="Live model" hint="Gemini Live model id">
        <UInputMenu
          v-model="form.liveModel"
          :items="geminiModelItems"
          create-item
          class="w-full font-mono text-xs"
          @create="value => (form.liveModel = value)"
        />
        <template #help>
          <span v-if="geminiModels?.error" class="text-xs text-muted">
            Could not list models: {{ geminiModels.error }} — type the id manually.
          </span>
        </template>
      </UFormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Voice">
          <USelectMenu v-model="form.voiceName" :items="GEMINI_VOICES" class="w-full" />
        </UFormField>
        <UFormField label="Spoken language">
          <UInput v-model="form.language" class="w-full" placeholder="en-US" />
        </UFormField>
      </div>
    </template>

    <template v-else>
      <UFormField label="Live model" hint="GPT-Live model id">
        <UInputMenu
          v-model="form.openaiLiveModel"
          :items="openAiLiveItems"
          create-item
          class="w-full font-mono text-xs"
          @create="value => (form.openaiLiveModel = value)"
        />
        <template #help>
          <span v-if="openAiModels?.error" class="text-xs text-muted">
            Could not list models: {{ openAiModels.error }} — type the id manually.
          </span>
        </template>
      </UFormField>
      <UFormField label="Voice" help="Fixed for the life of a connection; a change applies next time.">
        <USelectMenu v-model="form.openaiVoiceName" :items="OPENAI_VOICES" class="w-full" />
      </UFormField>

      <USeparator />

      <UFormField
        label="Thinking"
        hint="The live model delegates"
        help="GPT-Live runs the conversation and hands the reasoning and tool use to a backend."
      >
        <URadioGroup
          v-model="form.openaiDelegation.target"
          :items="[
            {
              value: 'responses',
              label: 'An OpenAI model',
              description: 'OpenAI calls the model below with Domo\'s tools attached. Nothing else to set up.'
            },
            {
              value: 'agent',
              label: 'A coding agent session',
              description: 'Domo hands each request to a coding agent, which answers with its own tools.'
            }
          ]"
        />
      </UFormField>

      <template v-if="form.openaiDelegation.target === 'responses'">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Backend model">
            <UInputMenu
              v-model="form.openaiDelegation.responsesModel"
              :items="responsesModelItems"
              create-item
              class="w-full font-mono text-xs"
              @create="value => (form.openaiDelegation.responsesModel = value)"
            />
          </UFormField>
          <UFormField label="Reasoning effort">
            <USelectMenu
              v-model="form.openaiDelegation.reasoningEffort"
              :items="effortItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>
        </div>
      </template>

      <template v-else>
        <UFormField
          label="Thinking agent"
          help="Everything the agent can reach through Domo's own MCP tools, it can do for you out loud."
        >
          <USelectMenu v-model="agentChoice" :items="agentItems" value-key="value" class="w-full" />
        </UFormField>
        <div v-if="!form.openaiDelegation.agentSessionId" class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Adapter" help="Which coding agent the created session runs.">
            <USelectMenu
              v-model="form.openaiDelegation.agentAdapter"
              :items="adapterItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Development environment">
            <USelectMenu
              v-model="environmentChoice"
              :items="environmentItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>
        </div>
        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="What this mode cannot do"
          description="The conversation-only tools — naming a conversation, starting a new one, answering a permission out loud — belong to the live model's backend, and a coding agent is not one. Titles stay as you set them, and permissions are answered on screen."
        />
      </template>
    </template>
  </div>
</template>
