<script setup lang="ts">
import type { AgentVoice } from '~/composables/useAgentVoice'

/**
 * The composer's voice mode: what stands where the text box is while talking.
 * One row, built for a thumb: the microphone (its ring is the input level),
 * the one line that says what is happening, and hushing a reply. The rest
 * of the voice controls (tap or hands-free, the quick settings, the speaker,
 * cancelling the turn) sit in the composer's footer with everything else,
 * and `AgentComposer` owns the `useAgentVoice` behind all of them.
 *
 * Its height is fixed: what it says changes all the time, and a box that grew
 * with each notice would move the transcript above it.
 */
const props = defineProps<{ voice: AgentVoice }>()

const status = computed(() => {
  const voice = props.voice
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
  switch (props.voice.lastCommand.value) {
    case 'hush': return 'Hushed'
    case 'cancel': return 'Turn cancelled'
    case 'send': return 'Sent'
    default: return null
  }
})

async function onMic() {
  const voice = props.voice
  if (voice.mode.value === 'click') {
    await voice.toggleRecording()
    return
  }
  if (voice.micEnabled.value) voice.stop()
  else await voice.start()
}

const micLabel = computed(() => {
  const voice = props.voice
  if (voice.mode.value === 'click') return voice.recording.value ? 'Tap to send' : 'Tap to talk'
  return voice.micEnabled.value ? 'Listening · tap to stop' : 'Tap for hands-free'
})

/**
 * The one line that says what is happening, most specific first: an error,
 * words held for the turn, the sentence being read out, a passing notice,
 * then the state.
 */
const live = computed(() => {
  const voice = props.voice
  if (voice.errorMessage.value) return { icon: 'i-lucide-circle-alert', text: voice.errorMessage.value, tone: 'error' }
  if (voice.utterance.value) return { icon: 'i-lucide-ear', text: voice.utterance.value, tone: 'live' }
  if (voice.spokenText.value && voice.speakEnabled.value) return { icon: 'i-lucide-audio-lines', text: voice.spokenText.value, tone: 'live' }
  if (voice.notice.value) return { icon: 'i-lucide-info', text: voice.notice.value, tone: 'muted' }
  return { icon: null, text: status.value, tone: 'muted' }
})

const recordingClick = computed(() => props.voice.recording.value && props.voice.mode.value === 'click')

/** The microphone's level as a ring around the button, which is where the eye already is. */
const ring = computed(() => {
  const level = props.voice.micEnabled.value ? props.voice.inputLevel.value : 0
  return { boxShadow: `0 0 0 ${Math.round(level * 8)}px color-mix(in oklab, var(--ui-primary) 28%, transparent)` }
})
</script>

<template>
  <div class="flex h-10 w-full items-center gap-2.5" data-testid="voice-bar">
    <UTooltip :text="micLabel">
      <UButton
        :icon="recordingClick ? 'i-lucide-square' : 'i-lucide-mic'"
        :color="recordingClick ? 'error' : 'primary'"
        :variant="voice.micEnabled.value ? 'solid' : 'soft'"
        :aria-label="micLabel"
        class="size-10 shrink-0 justify-center rounded-full transition-shadow duration-100"
        :class="voice.recording.value ? 'animate-pulse' : ''"
        :ui="{ leadingIcon: 'size-5' }"
        :style="ring"
        @click="onMic"
      />
    </UTooltip>

    <p
      class="min-w-0 flex-1 text-sm leading-5 line-clamp-2"
      :class="live.tone === 'error' ? 'text-error' : live.tone === 'live' ? 'text-default' : 'text-muted'"
      aria-live="polite"
    >
      <UIcon
        v-if="live.icon"
        :name="live.icon"
        class="me-1 inline-block size-3.5 align-[-2px]"
        :class="live.tone === 'error' ? 'text-error' : live.tone === 'live' ? 'text-primary' : 'text-muted'"
      />{{ live.text }}
    </p>

    <UBadge v-if="commandLabel" color="neutral" variant="subtle" size="sm" :label="commandLabel" class="shrink-0" />
    <template v-if="voice.utterance.value">
      <UButton label="Send" size="xs" color="primary" variant="soft" class="shrink-0" @click="voice.sendHeld()" />
      <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Discard" class="shrink-0" @click="voice.discardHeld()" />
    </template>
    <UTooltip v-else-if="voice.speaking.value || voice.synthesizing.value" text="Stop talking. The agent keeps working.">
      <UButton icon="i-lucide-volume-x" color="neutral" variant="subtle" size="sm" aria-label="Hush" class="shrink-0" @click="voice.hush()" />
    </UTooltip>
  </div>
</template>
