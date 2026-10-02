<script setup lang="ts">
import type { AppSettingsView, SecretSettingKey } from '~~/shared/types'

/**
 * The credentials, write-only on purpose: `GET /api/settings` answers whether
 * each is configured and never its value, so a box starts empty whether or not
 * one is stored, and only a typed value is ever sent. Removal is its own
 * action. A variable in `.env` wins over what is stored here, and "configured"
 * does not say which of the two it is.
 */
const props = defineProps<{ settings: AppSettingsView | null }>()
const emit = defineEmits<{ saved: [] }>()
const toast = useToast()

interface Credential {
  key: SecretSettingKey
  label: string
  help: string
  placeholder: string
  configured: (settings: AppSettingsView) => boolean
}

const credentials: Credential[] = [
  {
    key: 'geminiApiKey',
    label: 'Gemini API key',
    help: 'For the Gemini Live voice provider. Get one at aistudio.google.com/apikey.',
    placeholder: 'AIza…',
    configured: settings => settings.hasGeminiKey
  },
  {
    key: 'openAiApiKey',
    label: 'OpenAI API key',
    help: 'For the GPT-Live voice provider, and a Codex credential.',
    placeholder: 'sk-…',
    configured: settings => settings.hasOpenAiKey
  },
  {
    key: 'claudeCodeOauthToken',
    label: 'Claude Code token',
    help: 'From `claude setup-token`, billed to your Claude subscription. How Claude Code runs inside development environments, and what shows your Claude plan limits.',
    placeholder: 'sk-ant-oat…',
    configured: settings => settings.hasClaudeCodeToken
  },
  {
    key: 'anthropicApiKey',
    label: 'Anthropic API key',
    help: 'Optional. Bills the API, not your subscription, so it is used only when there is no Claude login or token.',
    placeholder: 'sk-ant-api…',
    configured: settings => settings.hasAnthropicKey
  },
  {
    key: 'huggingFaceToken',
    label: 'Hugging Face token',
    help: 'Optional. For cloning voices with Pocket TTS: a token of an account that accepted Kyutai\'s terms on huggingface.co/kyutai/pocket-tts.',
    placeholder: 'hf_…',
    configured: settings => settings.hasHuggingFaceToken
  }
]

const drafts = reactive<Partial<Record<SecretSettingKey, string>>>({})
const busy = reactive<Partial<Record<SecretSettingKey, boolean>>>({})

const isConfigured = (credential: Credential) => !!props.settings && credential.configured(props.settings)

async function write(credential: Credential, value: string) {
  busy[credential.key] = true
  try {
    await $fetch('/api/settings', { method: 'PATCH', body: { [credential.key]: value } })
    drafts[credential.key] = ''
    emit('saved')
    toast.add({ title: value ? `${credential.label} saved` : `${credential.label} removed`, color: 'success', icon: 'i-lucide-check' })
  } catch (error: any) {
    toast.add({ title: `Could not ${value ? 'save' : 'remove'} the ${credential.label.toLowerCase()}`, description: error?.message, color: 'error' })
  } finally {
    busy[credential.key] = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <UFormField
      v-for="credential in credentials"
      :key="credential.key"
      :label="credential.label"
      :help="credential.help"
    >
      <div class="flex items-center gap-2">
        <UInput
          v-model="drafts[credential.key]"
          type="password"
          class="flex-1"
          autocomplete="off"
          :placeholder="isConfigured(credential) ? 'Configured — type a new one to replace it' : credential.placeholder"
        />
        <UButton
          color="neutral"
          variant="subtle"
          icon="i-lucide-save"
          :disabled="!drafts[credential.key]?.trim()"
          :loading="busy[credential.key]"
          @click="write(credential, drafts[credential.key]!.trim())"
        >
          Save
        </UButton>
        <UButton
          v-if="isConfigured(credential)"
          color="neutral"
          variant="subtle"
          icon="i-lucide-trash-2"
          :loading="busy[credential.key]"
          @click="write(credential, '')"
        >
          Remove
        </UButton>
      </div>
    </UFormField>
  </div>
</template>
