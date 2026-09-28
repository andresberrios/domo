<script setup lang="ts">
import type { AgentVoiceSettings } from '~~/shared/types'
import { KOKORO_VOICES, OPENAI_SPEECH_VOICES, SPEECH_ENGINES, TURN_DETECTORS } from '~~/shared/agent-voice'
import { GEMINI_VOICES } from '~~/shared/voice-providers'

/**
 * The cascade behind talking to a coding agent: who hears, who speaks, and
 * each engine's own knobs. Two pickers rather than one, because the engines
 * are worth mixing: the local transcriber is the fastest one here, and a
 * vendor voice may still sound better than the local one. Only the chosen
 * engines' fields are shown; the rest are kept, so switching back finds them.
 */
const form = defineModel<AgentVoiceSettings>({ required: true })

const props = defineProps<{
  /** The live agent's Gemini voice, which the Gemini speaker shares. */
  geminiVoice: string
  hasGeminiKey?: boolean
  hasOpenAiKey?: boolean
}>()

const engineItems = SPEECH_ENGINES.map(engine => ({ label: engine.label, value: engine.id, description: engine.description }))

function keyWarning(engine: AgentVoiceSettings['transcriber']): string | null {
  if (engine === 'gemini' && props.hasGeminiKey === false) return 'No Gemini key is set, so this engine will fail.'
  if (engine === 'openai' && props.hasOpenAiKey === false) return 'No OpenAI key is set, so this engine will fail.'
  return null
}

const detectorItems = TURN_DETECTORS.map(detector => ({ label: detector.label, value: detector.id, description: detector.description }))

const uses = computed(() => new Set([
  form.value.transcriber,
  form.value.speaker,
  ...form.value.turnDetector === 'kyutai' ? ['kyutai' as const] : []
]))
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Transcriber" description="Turns what you say into text.">
        <USelectMenu
          v-model="form.transcriber"
          :items="engineItems"
          value-key="value"
          class="w-full"
        />
        <p v-if="keyWarning(form.transcriber)" class="mt-1 text-xs text-warning">{{ keyWarning(form.transcriber) }}</p>
      </UFormField>
      <UFormField label="Speaker" description="Reads the agent's replies out loud.">
        <USelectMenu
          v-model="form.speaker"
          :items="engineItems"
          value-key="value"
          class="w-full"
        />
        <p v-if="keyWarning(form.speaker)" class="mt-1 text-xs text-warning">{{ keyWarning(form.speaker) }}</p>
      </UFormField>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="End of turn" description="Hands-free: what decides, at a pause, that you have finished.">
        <USelectMenu
          v-model="form.turnDetector"
          :items="detectorItems"
          value-key="value"
          class="w-full"
        />
      </UFormField>
      <UFormField v-if="form.turnDetector === 'silence'" label="Silence" hint="seconds">
        <UInputNumber v-model="form.silenceSeconds" :min="0.3" :max="30" :step="0.1" class="w-full" />
      </UFormField>
    </div>

    <div v-if="uses.has('local')" class="grid gap-4 sm:grid-cols-2">
      <UFormField v-if="form.transcriber === 'local'" label="Local transcription model" hint="transformers.js id">
        <UInput v-model="form.localTranscribeModel" class="w-full font-mono text-xs" placeholder="onnx-community/moonshine-base-ONNX" />
      </UFormField>
      <UFormField v-if="form.speaker === 'local'" label="Kokoro voice" hint="a = American, b = British; f/m">
        <USelectMenu v-model="form.localVoice" :items="KOKORO_VOICES" class="w-full" />
      </UFormField>
    </div>

    <div v-if="uses.has('gemini')" class="grid gap-4 sm:grid-cols-2">
      <UFormField v-if="form.transcriber === 'gemini'" label="Gemini transcription model">
        <UInput v-model="form.geminiTranscribeModel" class="w-full font-mono text-xs" />
      </UFormField>
      <UFormField v-if="form.speaker === 'gemini'" label="Gemini speech model" :hint="`Voice: ${geminiVoice}, from the voice agent above`">
        <UInput v-model="form.geminiSpeechModel" class="w-full font-mono text-xs" />
        <p class="mt-1 text-xs text-muted">Voices: {{ GEMINI_VOICES.join(', ') }}.</p>
      </UFormField>
    </div>

    <div v-if="uses.has('openai')" class="grid gap-4 sm:grid-cols-3">
      <UFormField v-if="form.transcriber === 'openai'" label="OpenAI transcription model">
        <UInput v-model="form.openaiTranscribeModel" class="w-full font-mono text-xs" />
      </UFormField>
      <UFormField v-if="form.speaker === 'openai'" label="OpenAI speech model">
        <UInput v-model="form.openaiSpeechModel" class="w-full font-mono text-xs" />
      </UFormField>
      <UFormField v-if="form.speaker === 'openai'" label="OpenAI voice">
        <USelectMenu v-model="form.openaiVoice" :items="OPENAI_SPEECH_VOICES" class="w-full" />
      </UFormField>
    </div>

    <div v-if="uses.has('kyutai')" class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Kyutai server" description="A moshi-server, as Unmute runs it. The key comes from NUXT_KYUTAI_API_KEY.">
        <UInput v-model="form.kyutaiUrl" class="w-full font-mono text-xs" placeholder="ws://127.0.0.1:8080" />
      </UFormField>
      <UFormField v-if="form.speaker === 'kyutai'" label="Kyutai voice" hint="a path in kyutai/tts-voices">
        <UInput v-model="form.kyutaiVoice" class="w-full font-mono text-xs" />
      </UFormField>
    </div>
  </div>
</template>
