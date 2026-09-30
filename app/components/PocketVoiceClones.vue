<script setup lang="ts">
import type { ClonedVoice } from '~~/shared/types'
import { CLONED_VOICE_PREFIX, DEFAULT_AGENT_VOICE, VOICE_SAMPLE_MAX_SECONDS, VOICE_SAMPLE_MIN_SECONDS, VOICE_SAMPLE_RATE, VOICE_SAMPLE_SCRIPT } from '~~/shared/agent-voice'
import { RECORDER_WORKLET, encodeWav, toVoiceSample } from '~/utils/pcm'

/**
 * The user's own Pocket TTS voices: record 10-15 s or upload a file, hear it
 * back, name it, keep it. Pocket copies the sample's sound, room and
 * microphone included, so the microphone is opened with the browser's echo
 * cancelling, noise suppression and gain control off: a cleaned-up
 * recording would be cloned as cleaned-up speech.
 *
 * `voice` is the Settings form's `pocketVoice`: a kept voice is chosen, and
 * a deleted one that was chosen goes back to the default.
 */
const voice = defineModel<string>('voice', { required: true })

const toast = useToast()
const { data: clones, refresh } = useClonedVoices()

type Stage = 'idle' | 'recording' | 'review'
const stage = ref<Stage>('idle')
const error = ref<string | null>(null)
const draft = ref<{ wav: Blob, url: string, seconds: number, trimmed: boolean } | null>(null)
const name = ref('')
const saving = ref(false)

const elapsed = ref(0)
const level = ref(0)
let stream: MediaStream | null = null
let context: AudioContext | null = null
let chunks: Float32Array[] = []
let timer: ReturnType<typeof setInterval> | null = null

function message(caught: any): string {
  return caught?.data?.statusMessage ?? caught?.statusMessage ?? caught?.message ?? String(caught)
}

function closeMicrophone() {
  if (timer) clearInterval(timer)
  timer = null
  stream?.getTracks().forEach(track => track.stop())
  stream = null
  void context?.close().catch(() => {})
  context = null
}

async function startRecording() {
  error.value = null
  discard()
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    })
    context = new AudioContext()
    // Inside the tap, or iOS leaves it suspended.
    await context.resume()
    const blob = new Blob([RECORDER_WORKLET], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    await context.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    const source = context.createMediaStreamSource(stream)
    const recorder = new AudioWorkletNode(context, 'domo-recorder')
    chunks = []
    recorder.port.onmessage = (event) => {
      if (event.data?.type !== 'chunk') return
      chunks.push(event.data.samples)
      level.value = Math.min(1, event.data.level * 1.5)
    }
    source.connect(recorder)
    // A worklet with nowhere to send its output may never be run.
    const sink = context.createGain()
    sink.gain.value = 0
    recorder.connect(sink).connect(context.destination)
    const started = Date.now()
    elapsed.value = 0
    timer = setInterval(() => {
      elapsed.value = (Date.now() - started) / 1000
      if (elapsed.value >= VOICE_SAMPLE_MAX_SECONDS) void stopRecording()
    }, 100)
    stage.value = 'recording'
  } catch (caught) {
    closeMicrophone()
    error.value = `Could not open the microphone: ${message(caught)}`
  }
}

async function stopRecording() {
  if (stage.value !== 'recording' || !context) return
  const rate = context.sampleRate
  closeMicrophone()
  const recorded = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    recorded.set(chunk, offset)
    offset += chunk.length
  }
  chunks = []
  level.value = 0
  await review(await encodeWav(recorded, rate).arrayBuffer(), name.value || 'My voice')
}

const fileInput = ref<HTMLInputElement | null>(null)
async function uploaded(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = null
  discard()
  if (file.size > 50e6) {
    error.value = 'That file is larger than 50 MB. A voice needs 10-15 s.'
    return
  }
  await review(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, '').slice(0, 40))
}

async function review(audio: ArrayBuffer, suggestedName: string) {
  try {
    const sample = await toVoiceSample(audio, VOICE_SAMPLE_RATE, VOICE_SAMPLE_MAX_SECONDS)
    draft.value = { ...sample, url: URL.createObjectURL(sample.wav) }
    if (!name.value) name.value = suggestedName
    stage.value = 'review'
  } catch (caught) {
    stage.value = 'idle'
    error.value = `Could not read that audio: ${message(caught)}`
  }
}

function discard() {
  if (draft.value) URL.revokeObjectURL(draft.value.url)
  draft.value = null
  stage.value = 'idle'
}

const tooShort = computed(() => !!draft.value && draft.value.seconds < VOICE_SAMPLE_MIN_SECONDS)

async function keep() {
  if (!draft.value) return
  primePlayer()
  saving.value = true
  error.value = null
  try {
    const body = new FormData()
    body.append('name', name.value)
    body.append('sample', draft.value.wav, 'sample.wav')
    const created = await $fetch<ClonedVoice>('/api/agent-voice/voices', { method: 'POST', body })
    await refresh()
    discard()
    name.value = ''
    voice.value = `${CLONED_VOICE_PREFIX}${created.id}`
    toast.add({ title: `${created.name} is ready`, description: 'Chosen as the Pocket TTS voice. Save to keep the choice.', color: 'success', icon: 'i-lucide-check' })
    // Heard at once: the user learns whether the clone works while still here.
    await preview(created)
  } catch (caught) {
    error.value = message(caught)
  } finally {
    saving.value = false
  }
}

const previewing = ref<string | null>(null)
let player: HTMLAudioElement | null = null
let playerUrl: string | null = null
/**
 * The preview arrives seconds after the tap, and Safari only lets an element
 * play later if it was first played inside the tap. So one element is
 * started, silent, in the handler, and the preview reuses it.
 */
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='
function primePlayer() {
  player ??= new Audio()
  player.src = SILENCE
  void player.play().catch(() => {})
}

async function preview(entry: ClonedVoice) {
  primePlayer()
  previewing.value = entry.id
  error.value = null
  try {
    // Not $fetch: its error would hold the JSON as a Blob, and over HTTP/2
    // there is no status text to fall back on.
    const response = await fetch(`/api/agent-voice/voices/${entry.id}/preview`, { method: 'POST' })
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.statusMessage ?? body?.message ?? `The server answered ${response.status}.`)
    }
    const wav = await response.blob()
    if (playerUrl) URL.revokeObjectURL(playerUrl)
    playerUrl = URL.createObjectURL(wav)
    player!.src = playerUrl
    await player!.play()
  } catch (caught) {
    error.value = `${entry.name}: ${message(caught)}`
  } finally {
    previewing.value = null
  }
}

const deleting = ref<ClonedVoice | null>(null)
const removing = ref(false)
async function remove() {
  const entry = deleting.value
  if (!entry) return
  removing.value = true
  try {
    await $fetch(`/api/agent-voice/voices/${entry.id}`, { method: 'DELETE' })
    if (voice.value === `${CLONED_VOICE_PREFIX}${entry.id}`) voice.value = DEFAULT_AGENT_VOICE.pocketVoice
    await refresh()
    deleting.value = null
  } catch (caught) {
    toast.add({ title: 'Could not delete the voice', description: message(caught), color: 'error' })
  } finally {
    removing.value = false
  }
}

const deleteOpen = computed({
  get: () => !!deleting.value,
  set: (open: boolean) => { if (!open) deleting.value = null }
})

function clock(seconds: number) {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

onBeforeUnmount(() => {
  closeMicrophone()
  player?.pause()
  if (playerUrl) URL.revokeObjectURL(playerUrl)
  if (draft.value) URL.revokeObjectURL(draft.value.url)
})
</script>

<template>
  <div class="space-y-3 rounded-lg border border-default p-3">
    <div>
      <p class="text-sm font-medium">Your voices</p>
      <p class="text-xs text-muted">
        Pocket TTS can speak in a voice cloned from 10-15 s of speech. It copies the recording too, so record somewhere quiet, close to the microphone.
      </p>
    </div>

    <ul v-if="clones?.length" class="divide-y divide-default rounded-md border border-default">
      <li v-for="entry in clones" :key="entry.id" class="flex items-center gap-2 px-2 py-1.5">
        <UIcon :name="CLONED_VOICE_ICON" class="size-4 shrink-0 text-muted" />
        <span class="min-w-0 flex-1 truncate text-sm">{{ entry.name }}</span>
        <UBadge v-if="voice === `${CLONED_VOICE_PREFIX}${entry.id}`" label="Chosen" color="primary" variant="subtle" size="sm" />
        <span class="shrink-0 text-xs text-dimmed">{{ entry.seconds }} s</span>
        <UButton
          icon="i-lucide-play"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="previewing === entry.id"
          :aria-label="`Hear ${entry.name}`"
          @click="preview(entry)"
        />
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="`Delete ${entry.name}`"
          @click="deleting = entry"
        />
      </li>
    </ul>

    <UAlert v-if="error" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="error" />

    <div v-if="stage === 'idle'" class="flex flex-wrap gap-2">
      <UButton icon="i-lucide-mic" label="Record a voice" color="neutral" variant="outline" @click="startRecording" />
      <UButton icon="i-lucide-upload" label="Upload a file" color="neutral" variant="outline" @click="fileInput?.click()" />
      <input
        ref="fileInput"
        type="file"
        accept="audio/wav,audio/x-wav,audio/wave,audio/mpeg,.wav,.mp3"
        class="hidden"
        data-testid="voice-file"
        @change="uploaded"
      >
    </div>

    <div v-else-if="stage === 'recording'" class="space-y-3">
      <p class="text-xs text-muted">Read this aloud, at your usual pace:</p>
      <blockquote class="border-s-2 border-primary ps-3 text-sm leading-relaxed">
        {{ VOICE_SAMPLE_SCRIPT }}
      </blockquote>
      <div class="flex items-center gap-3">
        <span class="w-10 shrink-0 font-mono text-sm tabular-nums" :class="elapsed >= 10 ? 'text-success' : ''">{{ clock(elapsed) }}</span>
        <UProgress :model-value="level * 100" size="sm" class="flex-1" aria-label="Microphone level" />
        <UButton icon="i-lucide-square" label="Stop" color="error" @click="stopRecording" />
      </div>
      <p class="text-xs text-dimmed">10-15 s is enough; it stops by itself at {{ VOICE_SAMPLE_MAX_SECONDS }} s.</p>
    </div>

    <div v-else-if="draft" class="space-y-3">
      <audio :src="draft.url" controls class="w-full" />
      <p class="text-xs" :class="tooShort ? 'text-warning' : 'text-muted'">
        {{ draft.seconds.toFixed(1) }} s<template v-if="draft.trimmed">, the first {{ VOICE_SAMPLE_MAX_SECONDS }} s of the file</template>.
        <template v-if="tooShort">Pocket needs at least {{ VOICE_SAMPLE_MIN_SECONDS }} s of speech.</template>
      </p>
      <UFormField label="Name">
        <UInput v-model="name" maxlength="40" placeholder="My voice" class="w-full" />
      </UFormField>
      <div class="flex flex-wrap gap-2">
        <UButton icon="i-lucide-check" label="Keep" :loading="saving" :disabled="tooShort || !name.trim()" @click="keep" />
        <UButton icon="i-lucide-rotate-ccw" label="Record again" color="neutral" variant="outline" @click="startRecording" />
        <UButton label="Discard" color="neutral" variant="ghost" @click="discard" />
      </div>
    </div>

    <ConfirmModal
      v-model:open="deleteOpen"
      :title="`Delete ${deleting?.name ?? 'this voice'}?`"
      description="Its recording is removed from this server. If it is the chosen voice, Pocket TTS goes back to the default one."
      :loading="removing"
      @confirm="remove"
    />
  </div>
</template>
