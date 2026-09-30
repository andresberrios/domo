<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

/**
 * Talking to this agent. Sits above the composer, and is the whole voice UI:
 * how a turn is recorded (click, or hands-free with a sign-off), what was
 * heard, what is being said, and the two interruptions — hush the voice, or
 * cancel the turn.
 */
const props = defineProps<{ session: AgentSession }>()

const busy = computed(() => props.session.status === 'thinking' || props.session.status === 'awaiting-permission')

const { data: appSettings } = useSettings()
const voice = useAgentVoice(() => props.session.id, { busy, toolSound: () => appSettings.value?.agentVoice?.toolSound })

const modeItems = [
  { value: 'click', label: 'Click to talk', icon: 'i-lucide-mouse-pointer-click' },
  { value: 'handsfree', label: 'Hands-free', icon: 'i-lucide-radio' }
] as const

const status = computed(() => {
  if (voice.errorMessage.value) return voice.errorMessage.value
  if (voice.state.value === 'connecting') return 'Connecting…'
  if (voice.captureSuspended.value) return 'The browser paused the microphone. Tap it to resume.'
  if (voice.transcribing.value) return 'Transcribing…'
  if (voice.mode.value === 'click') {
    if (voice.recording.value) return 'Recording. Tap again to send.'
    return 'Tap the microphone, talk, and tap again to send.'
  }
  if (!voice.micEnabled.value) return 'Hands-free: turn the microphone on and just talk.'
  if (voice.recording.value) return 'Hearing you…'
  if (voice.holding.value) return 'Waiting for you to finish the thought…'
  return 'Listening. It sends when you sound done. “Stop” hushes it, “cancel” stops the turn.'
})

const commandLabel = computed(() => {
  switch (voice.lastCommand.value) {
    case 'hush': return 'Hushed'
    case 'cancel': return 'Turn cancelled'
    case 'send': return 'Sent'
    default: return null
  }
})

async function onMic() {
  if (voice.mode.value === 'click') {
    await voice.toggleRecording()
    return
  }
  if (voice.micEnabled.value) voice.stop()
  else await voice.start()
}

const micLabel = computed(() => {
  if (voice.mode.value === 'click') return voice.recording.value ? 'Tap to send' : 'Tap to talk'
  return voice.micEnabled.value ? 'Listening · tap to stop' : 'Tap for hands-free'
})

/**
 * The one line that says what is happening, most specific first: words held
 * for the turn, the sentence being read out, then the state.
 */
const live = computed(() => {
  if (voice.errorMessage.value) return { icon: 'i-lucide-circle-alert', text: voice.errorMessage.value, tone: 'text-error' }
  if (voice.utterance.value) return { icon: 'i-lucide-ear', text: voice.utterance.value, tone: 'text-default' }
  if (voice.spokenText.value && voice.speakEnabled.value) return { icon: 'i-lucide-audio-lines', text: voice.spokenText.value, tone: 'text-default' }
  return { icon: voice.recording.value ? 'i-lucide-audio-waveform' : 'i-lucide-info', text: status.value, tone: 'text-muted' }
})

/** The microphone's level as a ring around the button, which is where the eye already is. */
const ring = computed(() => {
  const level = voice.micEnabled.value ? voice.inputLevel.value : 0
  return { boxShadow: `0 0 0 ${Math.round(level * 8)}px color-mix(in oklab, var(--ui-primary) 28%, transparent)` }
})

/** A message asked to be heard again; the bar may have just been opened for it. */
const { request: replayRequest } = useAgentVoiceReplay()
watch(replayRequest, (request) => {
  if (!request) return
  replayRequest.value = null
  void voice.replay(request.text)
}, { immediate: true })

onMounted(() => {
  // The socket, not the microphone: a microphone opened here is one opened
  // outside a tap, which iOS leaves suspended. The first tap on the button
  // opens it.
  voice.connect()
  void voice.refreshDevices()
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl">
    <!--
      Built for a phone first: one line that says what is happening, then the
      controls around a large microphone in the middle, where a thumb finds
      it. The mode and the input device sit to its left, the interruptions and
      the speaker to its right; on a wide screen the same row just has room.
    -->
    <div class="rounded-2xl border border-default bg-elevated/60 px-3 pb-2.5 pt-2">
      <div class="flex min-h-10 sm:min-h-6 items-start gap-2 text-sm leading-snug" aria-live="polite">
        <UIcon :name="live.icon" class="mt-0.5 size-4 shrink-0" :class="live.tone === 'text-muted' ? 'text-muted' : live.tone === 'text-error' ? 'text-error' : 'text-primary'" />
        <p class="min-w-0 flex-1 line-clamp-2" :class="live.tone">
          {{ live.text }}
        </p>
        <UBadge v-if="commandLabel" color="neutral" variant="subtle" size="sm" :label="commandLabel" class="shrink-0" />
        <template v-if="voice.utterance.value">
          <UButton label="Send" size="xs" color="primary" variant="soft" class="shrink-0" @click="voice.sendHeld()" />
          <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Discard" class="shrink-0" @click="voice.discardHeld()" />
        </template>
      </div>

      <div class="mt-1.5 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div class="flex min-w-0 items-center gap-1">
          <UFieldGroup size="sm">
            <UTooltip v-for="item in modeItems" :key="item.value" :text="item.label">
              <UButton
                :icon="item.icon"
                color="neutral"
                :variant="voice.mode.value === item.value ? 'solid' : 'subtle'"
                :aria-label="item.label"
                :aria-pressed="voice.mode.value === item.value"
                @click="voice.setMode(item.value)"
              >
                <span class="hidden sm:inline">{{ item.label }}</span>
              </UButton>
            </UTooltip>
          </UFieldGroup>
          <AgentVoiceQuickSettings
            :input-devices="voice.inputDevices.value"
            :input-device-id="voice.inputDeviceId.value"
            @update:input-device-id="(id: string) => voice.setInputDevice(id)"
          />
        </div>

        <div class="flex flex-col items-center gap-2">
          <UButton
            :icon="voice.recording.value && voice.mode.value === 'click' ? 'i-lucide-square' : 'i-lucide-mic'"
            :color="voice.recording.value && voice.mode.value === 'click' ? 'error' : 'primary'"
            :variant="voice.micEnabled.value ? 'solid' : 'soft'"
            :aria-label="micLabel"
            class="size-14 justify-center rounded-full transition-shadow duration-100"
            :class="voice.recording.value ? 'animate-pulse' : ''"
            :ui="{ leadingIcon: 'size-6' }"
            :style="ring"
            @click="onMic"
          />
          <span class="text-[11px] leading-none text-muted">{{ micLabel }}</span>
        </div>

        <div class="flex min-w-0 items-center justify-end gap-1">
          <UTooltip v-if="voice.speaking.value || voice.synthesizing.value" text="Stop talking. The agent keeps working.">
            <UButton icon="i-lucide-volume-x" color="neutral" variant="subtle" aria-label="Hush" @click="voice.hush()" />
          </UTooltip>
          <UTooltip v-if="busy" text="Cancel the agent's turn">
            <UButton icon="i-lucide-octagon-x" color="neutral" variant="ghost" aria-label="Cancel the turn" @click="voice.cancel()" />
          </UTooltip>
          <UTooltip :text="voice.speakEnabled.value ? 'Replies are read aloud' : 'Replies are silent'">
            <UButton
              :icon="voice.speakEnabled.value ? 'i-lucide-volume-2' : 'i-lucide-volume-off'"
              color="neutral"
              variant="ghost"
              :aria-label="voice.speakEnabled.value ? 'Mute replies' : 'Read replies aloud'"
              @click="voice.setSpeak(!voice.speakEnabled.value)"
            />
          </UTooltip>
        </div>
      </div>

      <p v-if="voice.notice.value" class="mt-1.5 truncate text-center text-xs text-muted">
        {{ voice.notice.value }}
      </p>
    </div>
  </div>
</template>
