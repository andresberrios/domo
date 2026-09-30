<script setup lang="ts">
import type { AgentVoiceSettings } from '~~/shared/types'
import { KOKORO_VOICES, OPENAI_SPEECH_VOICES, POCKET_VOICES, SPEAKERS, SPEECH_LANGUAGES, TOOL_SOUNDS, TRANSCRIBE_MODELS, TRANSCRIBERS, TURN_DETECTORS } from '~~/shared/agent-voice'
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
/** The voices on the Mac Domo runs on, asked for only when "This Mac" speaks. */
const macVoices = ref<Array<{ label: string, value: string, description: string }>>([])
const macUnavailable = ref<string | null>(null)
const QUALITY = ['', 'default', 'enhanced', 'premium']
watch(() => form.value.speaker === 'mac', async (mac) => {
  if (!mac || macVoices.value.length) return
  try {
    const answer = await $fetch<{ available: boolean, reason?: string, voices: Array<{ id: string, name: string, language: string, quality: number }> }>('/api/agent-voice/mac-voices')
    macUnavailable.value = answer.available ? null : answer.reason ?? 'Not available'
    const code = form.value.language || 'en'
    macVoices.value = [
      { label: 'Best installed', value: '', description: 'The highest-quality voice for the language' },
      ...answer.voices
        .filter(voice => voice.language.toLowerCase().startsWith(code))
        .sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name))
        .map(voice => ({ label: voice.name, value: voice.id, description: `${voice.language}, ${QUALITY[voice.quality] ?? ''}` }))
    ]
  } catch (error) {
    macUnavailable.value = error instanceof Error ? error.message : String(error)
  }
}, { immediate: true })

// The select refuses an empty value, and '' is how "the best one" is stored.
const macVoice = computed({
  get: () => form.value.macVoice || 'best',
  set: (value: string) => { form.value.macVoice = value === 'best' ? '' : value }
})
const macVoiceItems = computed(() => macVoices.value.map(item => ({ ...item, value: item.value || 'best' })))

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

function keyWarning(engine: AgentVoiceSettings['transcriber'] | AgentVoiceSettings['speaker']): string | null {
  if (engine === 'gemini' && props.hasGeminiKey === false) return 'No Gemini key is set, so this engine will fail.'
  if (engine === 'openai' && props.hasOpenAiKey === false) return 'No OpenAI key is set, so this engine will fail.'
  return null
}

/** The measured models as a menu, plus whatever id is stored, so a custom one is kept. */
function modelItems(engine: keyof typeof TRANSCRIBE_MODELS, current: string) {
  const items = TRANSCRIBE_MODELS[engine].map(model => ({ label: model.id, value: model.id, description: model.note }))
  return items.some(item => item.value === current) ? items : [...items, { label: current, value: current, description: 'Not measured.' }]
}

const toolSoundItems = TOOL_SOUNDS.map(sound => ({ label: sound.label, value: sound.id, description: sound.description }))

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
        <ChoiceMenu
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
        <ChoiceMenu
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
        <ChoiceMenu
          v-model="language"
          :items="languageItems"
          value-key="value"
          class="w-full"
        />
      </UFormField>
      <UFormField label="Tool call sound" description="What you hear when the agent uses a tool, so you know it is working.">
        <ChoiceMenu v-model="form.toolSound" :items="toolSoundItems" value-key="value" class="w-full" />
      </UFormField>
    </div>

    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="End of turn" description="Hands-free: what decides, at a pause, that you have finished.">
        <ChoiceMenu
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
        <ChoiceMenu
          :model-value="deviceVoiceName"
          :items="deviceVoices"
          value-key="value"
          placeholder="No voices for this language"
          class="w-full"
          @update:model-value="(name: string) => chooseDeviceVoice(name)"
        />
      </UFormField>
    </div>

    <div v-if="form.speaker === 'pocket'" class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Pocket TTS voice" description="The most natural first.">
        <ChoiceMenu v-model="form.pocketVoice" :items="POCKET_VOICES" class="w-full" />
      </UFormField>
      <UFormField label="Pocket TTS server" description="Empty: Domo runs it itself with uv (brew install uv). Or the URL of one you run.">
        <UInput v-model="form.pocketUrl" class="w-full font-mono text-xs" placeholder="http://127.0.0.1:8000" />
      </UFormField>
    </div>

    <div v-if="form.speaker === 'mac'" class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Mac voice" description="Premium and Enhanced voices are installed in System Settings, Accessibility, Spoken Content.">
        <ChoiceMenu v-model="macVoice" :items="macVoiceItems" value-key="value" class="w-full" />
        <p v-if="macUnavailable" class="mt-1 text-xs text-warning">{{ macUnavailable }}</p>
      </UFormField>
    </div>

    <div v-if="uses.has('local')" class="grid gap-4 sm:grid-cols-2">
      <UFormField v-if="form.transcriber === 'local'" label="Local transcription model" hint="transformers.js id">
        <ChoiceMenu
          v-model="form.localTranscribeModel"
          :items="modelItems('local', form.localTranscribeModel)"
          value-key="value"
          create-item
          class="w-full font-mono text-xs"
          @create="(id: string) => { form.localTranscribeModel = id }"
        />
      </UFormField>
      <UFormField v-if="form.speaker === 'local'" label="Kokoro voice" hint="a = American, b = British; f/m">
        <ChoiceMenu v-model="form.localVoice" :items="KOKORO_VOICES" class="w-full" />
      </UFormField>
    </div>

    <div v-if="uses.has('gemini')" class="grid gap-4 sm:grid-cols-2">
      <UFormField v-if="form.transcriber === 'gemini'" label="Gemini transcription model">
        <ChoiceMenu
          v-model="form.geminiTranscribeModel"
          :items="modelItems('gemini', form.geminiTranscribeModel)"
          value-key="value"
          create-item
          class="w-full font-mono text-xs"
          @create="(id: string) => { form.geminiTranscribeModel = id }"
        />
      </UFormField>
      <UFormField v-if="form.speaker === 'gemini'" label="Gemini speech model" :hint="`Voice: ${geminiVoice}, the voice agent's, set on General`">
        <UInput v-model="form.geminiSpeechModel" class="w-full font-mono text-xs" />
        <p class="mt-1 text-xs text-muted">Voices: {{ GEMINI_VOICES.join(', ') }}.</p>
      </UFormField>
    </div>

    <div v-if="uses.has('openai')" class="grid gap-4 sm:grid-cols-3">
      <UFormField v-if="form.transcriber === 'openai'" label="OpenAI transcription model">
        <ChoiceMenu
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
        <ChoiceMenu v-model="form.openaiVoice" :items="OPENAI_SPEECH_VOICES" class="w-full" />
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
