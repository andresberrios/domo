<script setup lang="ts">
import type { AgentVoiceSettings } from '~~/shared/types'
import { KOKORO_VOICES, OPENAI_SPEECH_VOICES, SPEAKERS, SPEECH_LANGUAGES, TRANSCRIBE_MODELS, TRANSCRIBERS, TURN_DETECTORS } from '~~/shared/agent-voice'
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

const speakerItems = SPEAKERS.map(engine => ({ label: engine.label, value: engine.id, description: engine.description }))

/** This device's voices, best first; the choice is kept in this browser, not in Settings. */
const deviceVoices = ref<Array<{ label: string, value: string, description: string }>>([])
const deviceVoiceName = ref('')
function loadDeviceVoices() {
  if (!('speechSynthesis' in window)) return
  const ranked = rankDeviceVoices(window.speechSynthesis.getVoices(), form.value.language)
  deviceVoices.value = ranked.map(voice => ({ label: voice.name, value: voice.name, description: `${voice.lang}${voice.localService ? '' : ', online'}` }))
  deviceVoiceName.value = storedDeviceVoice() || ranked[0]?.name || ''
}
onMounted(() => {
  loadDeviceVoices()
  if ('speechSynthesis' in window) window.speechSynthesis.addEventListener('voiceschanged', loadDeviceVoices)
})
onBeforeUnmount(() => {
  if ('speechSynthesis' in window) window.speechSynthesis.removeEventListener('voiceschanged', loadDeviceVoices)
})
watch(() => form.value.language, loadDeviceVoices)
function chooseDeviceVoice(name: string) {
  deviceVoiceName.value = name
  storeDeviceVoice(name)
  const voice = window.speechSynthesis.getVoices().find(v => v.name === name)
  if (!voice) return
  window.speechSynthesis.cancel()
  const sample = new SpeechSynthesisUtterance('This is how replies will sound.')
  sample.voice = voice
  sample.lang = voice.lang
  window.speechSynthesis.speak(sample)
}
const transcriberItems = TRANSCRIBERS.map(engine => ({ label: engine.label, value: engine.id, description: engine.description }))
// The select refuses an empty value, and '' is how "let the engine guess" is stored.
const languageItems = SPEECH_LANGUAGES.map(language => ({ label: language.label, value: language.id || 'auto' }))
const language = computed({
  get: () => form.value.language || 'auto',
  set: (value: string) => { form.value.language = value === 'auto' ? '' : value }
})

/** Whether the browser this page is open in has a recogniser of its own. The phone may differ. */
const hasDictation = ref(true)
onMounted(() => {
  hasDictation.value = !!((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition)
})

function keyWarning(engine: AgentVoiceSettings['transcriber']): string | null {
  if (engine === 'gemini' && props.hasGeminiKey === false) return 'No Gemini key is set, so this engine will fail.'
  if (engine === 'openai' && props.hasOpenAiKey === false) return 'No OpenAI key is set, so this engine will fail.'
  return null
}

/** The measured models as a menu, plus whatever id is stored, so a custom one is kept. */
function modelItems(engine: keyof typeof TRANSCRIBE_MODELS, current: string) {
  const items = TRANSCRIBE_MODELS[engine].map(model => ({ label: model.id, value: model.id, description: model.note }))
  return items.some(item => item.value === current) ? items : [...items, { label: current, value: current, description: 'Not measured.' }]
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
          :items="transcriberItems"
          value-key="value"
          class="w-full"
        />
        <p v-if="keyWarning(form.transcriber)" class="mt-1 text-xs text-warning">{{ keyWarning(form.transcriber) }}</p>
        <p v-if="form.transcriber === 'browser' && !hasDictation" class="mt-1 text-xs text-warning">
          This browser has no dictation of its own. Chrome, Edge and Safari do.
        </p>
      </UFormField>
      <UFormField label="Speaker" description="Reads the agent's replies out loud.">
        <USelectMenu
          v-model="form.speaker"
          :items="speakerItems"
          value-key="value"
          class="w-full"
        />
        <p v-if="keyWarning(form.speaker)" class="mt-1 text-xs text-warning">{{ keyWarning(form.speaker) }}</p>
      </UFormField>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Language" description="What you speak. Left to guess, noisy speech can come back in another language.">
        <USelectMenu
          v-model="language"
          :items="languageItems"
          value-key="value"
          class="w-full"
        />
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

    <div v-if="form.speaker === 'browser'" class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Voice on this device" description="Kept in this browser. Each device has its own voices; pick one and hear it.">
        <USelectMenu
          :model-value="deviceVoiceName"
          :items="deviceVoices"
          value-key="value"
          placeholder="No voices for this language"
          class="w-full"
          @update:model-value="(name: string) => chooseDeviceVoice(name)"
        />
      </UFormField>
    </div>

    <div v-if="uses.has('local')" class="grid gap-4 sm:grid-cols-2">
      <UFormField v-if="form.transcriber === 'local'" label="Local transcription model" hint="transformers.js id">
        <USelectMenu
          v-model="form.localTranscribeModel"
          :items="modelItems('local', form.localTranscribeModel)"
          value-key="value"
          create-item
          class="w-full font-mono text-xs"
          @create="(id: string) => { form.localTranscribeModel = id }"
        />
      </UFormField>
      <UFormField v-if="form.speaker === 'local'" label="Kokoro voice" hint="a = American, b = British; f/m">
        <USelectMenu v-model="form.localVoice" :items="KOKORO_VOICES" class="w-full" />
      </UFormField>
    </div>

    <div v-if="uses.has('gemini')" class="grid gap-4 sm:grid-cols-2">
      <UFormField v-if="form.transcriber === 'gemini'" label="Gemini transcription model">
        <USelectMenu
          v-model="form.geminiTranscribeModel"
          :items="modelItems('gemini', form.geminiTranscribeModel)"
          value-key="value"
          create-item
          class="w-full font-mono text-xs"
          @create="(id: string) => { form.geminiTranscribeModel = id }"
        />
      </UFormField>
      <UFormField v-if="form.speaker === 'gemini'" label="Gemini speech model" :hint="`Voice: ${geminiVoice}, from the voice agent above`">
        <UInput v-model="form.geminiSpeechModel" class="w-full font-mono text-xs" />
        <p class="mt-1 text-xs text-muted">Voices: {{ GEMINI_VOICES.join(', ') }}.</p>
      </UFormField>
    </div>

    <div v-if="uses.has('openai')" class="grid gap-4 sm:grid-cols-3">
      <UFormField v-if="form.transcriber === 'openai'" label="OpenAI transcription model">
        <USelectMenu
          v-model="form.openaiTranscribeModel"
          :items="modelItems('openai', form.openaiTranscribeModel)"
          value-key="value"
          create-item
          class="w-full font-mono text-xs"
          @create="(id: string) => { form.openaiTranscribeModel = id }"
        />
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
