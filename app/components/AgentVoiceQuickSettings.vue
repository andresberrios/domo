<script setup lang="ts">
import type { AgentVoiceSettings, AppSettingsView } from '~~/shared/types'
import {
  KOKORO_VOICES,
  OPENAI_SPEECH_VOICES,
  SPEAKERS,
  SPEECH_LANGUAGES,
  TOOL_SOUNDS,
  TRANSCRIBERS
} from '~~/shared/agent-voice'
import { GEMINI_VOICES } from '~~/shared/voice-providers'
import type { AudioInputDevice } from '~/composables/useAgentVoice'

/**
 * The voice bar's own settings, a tap away: who hears, who speaks and in
 * which voice, the language, the microphone and the tool call sound. The same
 * panel of columns as the composer's model picker, for the same reason:
 * these are changed while talking, and Settings is a page away.
 *
 * Every choice applies at once. Engines and voices are Settings, saved for
 * every device; the microphone and a device voice belong to this browser.
 * The model ids and each engine's finer knobs stay on the Settings page.
 */
const props = defineProps<{
  inputDevices: AudioInputDevice[]
  inputDeviceId: string
}>()
const emit = defineEmits<{ 'update:inputDeviceId': [deviceId: string] }>()

const toast = useToast()
const open = ref(false)
const { data: settings, refresh } = useSettings()
const voice = computed(() => settings.value?.agentVoice)

interface Item { value: string, label: string, description?: string, icon?: string }
interface Column {
  key: string
  label: string
  items: Item[]
  selected: string
  apply: (value: string) => Promise<void> | void
}

const applying = ref<{ key: string, value: string } | null>(null)

async function patch(body: Partial<AppSettingsView>) {
  await $fetch('/api/settings', { method: 'PATCH', body })
  await refresh()
}

async function setVoice(change: Partial<AgentVoiceSettings>) {
  if (!voice.value) return
  await patch({ agentVoice: { ...voice.value, ...change } })
}

async function choose(column: Column, value: string) {
  applying.value = { key: column.key, value }
  try {
    await column.apply(value)
  } catch (error: any) {
    toast.add({ title: `Could not change the ${column.label.toLowerCase()}`, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    applying.value = null
  }
}

/* The device's and the Mac's voices are only listed when they are the speaker. */
const deviceVoices = ref<Item[]>([])
const deviceVoiceName = ref('')
function loadDeviceVoices() {
  if (!('speechSynthesis' in window) || !voice.value) return
  const ranked = rankDeviceVoices(window.speechSynthesis.getVoices(), voice.value.language)
  deviceVoices.value = ranked.map(entry => ({ value: entry.name, label: entry.name, description: entry.lang }))
  deviceVoiceName.value = storedDeviceVoice() || ranked[0]?.name || ''
}
const { data: clones } = useClonedVoices()
const macVoices = ref<Item[]>([])
const QUALITY = ['', 'default', 'enhanced', 'premium']
async function loadMacVoices() {
  if (macVoices.value.length) return
  const answer = await $fetch<{ voices: Array<{ id: string, name: string, language: string, quality: number }> }>('/api/agent-voice/mac-voices').catch(() => null)
  const code = voice.value?.language || 'en'
  macVoices.value = [
    { value: '', label: 'Best installed' },
    ...(answer?.voices ?? [])
      .filter(entry => entry.language.toLowerCase().startsWith(code))
      .sort((a, b) => b.quality - a.quality || a.name.localeCompare(b.name))
      .map(entry => ({ value: entry.id, label: entry.name, description: `${entry.language}, ${QUALITY[entry.quality] ?? ''}` }))
  ]
}
watch([open, () => voice.value?.speaker], () => {
  if (!open.value) return
  if (voice.value?.speaker === 'browser') loadDeviceVoices()
  if (voice.value?.speaker === 'mac') void loadMacVoices()
}, { immediate: true })

const voiceColumn = computed<Column | null>(() => {
  const current = voice.value
  if (!current) return null
  const list = (names: readonly string[]) => names.map(name => ({ value: name, label: name }))
  switch (current.speaker) {
    case 'local':
      return { key: 'voice', label: 'Voice', items: list(KOKORO_VOICES), selected: current.localVoice, apply: value => setVoice({ localVoice: value }) }
    case 'openai':
      return { key: 'voice', label: 'Voice', items: list(OPENAI_SPEECH_VOICES), selected: current.openaiVoice, apply: value => setVoice({ openaiVoice: value }) }
    case 'gemini':
      // Gemini's voice is the live agent's too: one voice for both.
      return { key: 'voice', label: 'Voice', items: list(GEMINI_VOICES), selected: settings.value?.voiceName ?? '', apply: value => patch({ voiceName: value }) }
    case 'pocket':
      return { key: 'voice', label: 'Voice', items: pocketVoiceItems(clones.value ?? [], current.pocketVoice), selected: current.pocketVoice, apply: value => setVoice({ pocketVoice: value }) }
    case 'mac':
      return { key: 'voice', label: 'Voice', items: macVoices.value, selected: current.macVoice, apply: value => setVoice({ macVoice: value }) }
    case 'browser':
      return {
        key: 'voice',
        label: 'Voice on this device',
        items: deviceVoices.value,
        selected: deviceVoiceName.value,
        apply: (value) => {
          deviceVoiceName.value = value
          storeDeviceVoice(value)
          const chosen = window.speechSynthesis.getVoices().find(entry => entry.name === value)
          if (!chosen) return
          window.speechSynthesis.cancel()
          const sample = new SpeechSynthesisUtterance('This is how replies will sound.')
          sample.voice = chosen
          sample.lang = chosen.lang
          window.speechSynthesis.speak(sample)
        }
      }
    default:
      return null
  }
})

const columns = computed<Column[]>(() => {
  const current = voice.value
  if (!current) return []
  const described = (list: Array<{ id: string, label: string, description: string }>) =>
    list.map(entry => ({ value: entry.id, label: entry.label, description: entry.description }))
  return [
    { key: 'transcriber', label: 'Hear with', items: described(TRANSCRIBERS), selected: current.transcriber, apply: value => setVoice({ transcriber: value as AgentVoiceSettings['transcriber'] }) },
    { key: 'speaker', label: 'Speak with', items: described(SPEAKERS), selected: current.speaker, apply: value => setVoice({ speaker: value as AgentVoiceSettings['speaker'] }) },
    ...(voiceColumn.value ? [voiceColumn.value] : []),
    {
      key: 'language',
      label: 'Language',
      // The empty id is "detect", which the listbox renders like any other.
      items: SPEECH_LANGUAGES.map(language => ({ value: language.id, label: language.label })),
      selected: current.language,
      apply: value => setVoice({ language: value })
    },
    ...(props.inputDevices.length > 1
      ? [{
          key: 'microphone',
          label: 'Microphone',
          items: props.inputDevices.map(device => ({ value: device.deviceId, label: device.label })),
          selected: props.inputDeviceId || props.inputDevices[0]!.deviceId,
          apply: (value: string) => emit('update:inputDeviceId', value)
        }]
      : []),
    { key: 'tool', label: 'Tool call sound', items: described(TOOL_SOUNDS), selected: current.toolSound, apply: value => setVoice({ toolSound: value as AgentVoiceSettings['toolSound'] }) }
  ]
})

/** Each column opens on its chosen option, not its first: a voice list is long. */
const lists = ref<HTMLElement[]>([])
watch([open, columns], async () => {
  if (!open.value) return
  await nextTick()
  for (const list of lists.value) {
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!selected || list.scrollHeight <= list.clientHeight) continue
    list.scrollTop = selected.offsetTop - (list.clientHeight - selected.clientHeight) / 2
  }
})

function labelOf(list: Array<{ id: string, label: string }>, id: string | undefined) {
  return list.find(entry => entry.id === id)?.label ?? id ?? ''
}
const summary = computed(() => voice.value
  ? `${labelOf(TRANSCRIBERS, voice.value.transcriber)} · ${labelOf(SPEAKERS, voice.value.speaker)}`
  : 'Voice settings')
</script>

<template>
  <UPopover v-model:open="open" :content="{ side: 'top', align: 'start', collisionPadding: 8 }">
    <UTooltip text="Voice settings">
      <UButton
        icon="i-lucide-sliders-horizontal"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="`Voice settings: ${summary}`"
      />
    </UTooltip>

    <template #content>
      <div class="w-80 max-w-[calc(100vw-1rem)] sm:w-auto">
        <div class="flex items-center gap-2 border-b border-default px-3 py-2">
          <UIcon name="i-lucide-audio-lines" class="size-4 shrink-0 text-primary" />
          <span class="truncate text-sm font-semibold">{{ summary }}</span>
          <UButton to="/settings/voice" label="All settings" variant="link" size="xs" class="ms-auto shrink-0" />
        </div>
        <!-- Stacked and scrolled as one on a phone; side by side on a wider screen. -->
        <div class="flex max-h-[60vh] flex-col divide-y divide-default overflow-auto sm:max-h-none sm:max-w-[calc(100vw-2rem)] sm:flex-row sm:divide-x sm:divide-y-0">
          <div v-for="column in columns" :key="column.key" class="min-w-0 shrink-0 p-1.5 sm:w-44">
            <div :id="`voice-${column.key}-label`" class="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-dimmed">
              {{ column.label }}
            </div>
            <div ref="lists" role="listbox" :aria-labelledby="`voice-${column.key}-label`" class="relative max-h-56 overflow-y-auto sm:max-h-72">
              <p v-if="!column.items.length" class="px-2 py-1.5 text-xs text-dimmed">None available here.</p>
              <button
                v-for="item in column.items"
                :key="item.value"
                type="button"
                role="option"
                :aria-selected="item.value === column.selected"
                :title="item.description || undefined"
                class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-elevated"
                :class="item.value === column.selected ? 'bg-primary/10 text-primary' : ''"
                @click="choose(column, item.value)"
              >
                <span class="min-w-0">
                  <span class="flex items-center gap-1.5 text-sm" :class="item.value === column.selected ? 'font-medium' : ''">
                    <UIcon v-if="item.icon" :name="item.icon" class="size-3.5 shrink-0 text-muted" />
                    <span class="truncate">{{ item.label }}</span>
                  </span>
                  <span v-if="item.description" class="hidden text-[11px] leading-snug text-muted sm:line-clamp-2">{{ item.description }}</span>
                </span>
                <UIcon
                  v-if="applying?.key === column.key && applying.value === item.value"
                  name="i-lucide-loader-circle"
                  class="size-3.5 shrink-0 animate-spin"
                />
                <UIcon v-else-if="item.value === column.selected" name="i-lucide-check" class="size-3.5 shrink-0 text-primary" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UPopover>
</template>
