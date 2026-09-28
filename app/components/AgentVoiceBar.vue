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

const voice = useAgentVoice(() => props.session.id, { busy })

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
    if (voice.recording.value) return 'Recording. Click again to send.'
    return voice.micEnabled.value ? 'Click the microphone and talk.' : 'Click the microphone to start.'
  }
  if (!voice.micEnabled.value) return 'Turn the microphone on to talk hands-free.'
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
  if (voice.mode.value === 'click') return voice.recording.value ? 'Stop and send' : 'Talk'
  return voice.micEnabled.value ? 'Microphone off' : 'Microphone on'
})

/** The picker only appears when there is a choice to make. */
const deviceItems = computed(() => voice.inputDevices.value.map(device => ({ label: device.label, value: device.deviceId })))

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
    <div class="rounded-lg border border-default bg-elevated/50 px-3 py-2">
      <!--
        Two rows, because a phone is narrow: what you act on now, then how
        you have it set up. The status is allowed a second line rather than
        being cut, since on a phone it is the only feedback that fits.
      -->
      <div class="flex items-center gap-2">
        <UTooltip :text="micLabel">
          <UButton
            :icon="voice.recording.value ? 'i-lucide-square' : voice.micEnabled.value ? 'i-lucide-mic' : 'i-lucide-mic-off'"
            :color="voice.recording.value ? 'error' : voice.micEnabled.value ? 'primary' : 'neutral'"
            :variant="voice.recording.value || voice.micEnabled.value ? 'solid' : 'subtle'"
            size="xl"
            :aria-label="micLabel"
            :class="voice.recording.value ? 'animate-pulse' : ''"
            @click="onMic"
          />
        </UTooltip>

        <div class="h-8 w-1 shrink-0 overflow-hidden rounded-full bg-accented" aria-hidden="true">
          <div
            class="w-full rounded-full bg-primary transition-[height] duration-100"
            :style="{ height: `${Math.round(voice.inputLevel.value * 100)}%`, marginTop: `${100 - Math.round(voice.inputLevel.value * 100)}%` }"
          />
        </div>

        <div class="min-w-0 flex-1 text-xs leading-snug line-clamp-2" :class="voice.errorMessage.value ? 'text-error' : 'text-muted'">
          {{ status }}
        </div>

        <div class="flex shrink-0 items-center gap-1">
          <UBadge v-if="commandLabel" color="neutral" variant="subtle" size="sm" :label="commandLabel" class="hidden sm:inline-flex" />
          <UTooltip v-if="voice.speaking.value || voice.synthesizing.value" text="Stop talking. The agent keeps working.">
            <UButton
              icon="i-lucide-volume-x"
              color="neutral"
              variant="subtle"
              size="md"
              aria-label="Hush"
              @click="voice.hush()"
            />
          </UTooltip>
          <UTooltip v-if="busy" text="Cancel the agent's turn">
            <UButton
              icon="i-lucide-octagon-x"
              color="neutral"
              variant="ghost"
              size="md"
              aria-label="Cancel the turn"
              @click="voice.cancel()"
            />
          </UTooltip>
          <UTooltip :text="voice.speakEnabled.value ? 'Replies are read aloud' : 'Replies are silent'">
            <UButton
              :icon="voice.speakEnabled.value ? 'i-lucide-volume-2' : 'i-lucide-volume-off'"
              color="neutral"
              variant="ghost"
              size="md"
              :aria-label="voice.speakEnabled.value ? 'Mute replies' : 'Read replies aloud'"
              @click="voice.setSpeak(!voice.speakEnabled.value)"
            />
          </UTooltip>
        </div>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-2">
        <UFieldGroup size="sm" class="w-full sm:w-auto">
          <UButton
            v-for="item in modeItems"
            :key="item.value"
            :label="item.label"
            :icon="item.icon"
            color="neutral"
            :variant="voice.mode.value === item.value ? 'solid' : 'subtle'"
            class="flex-1 justify-center sm:flex-none"
            @click="voice.setMode(item.value)"
          />
        </UFieldGroup>

        <USelect
          v-if="deviceItems.length > 1"
          :model-value="voice.inputDeviceId.value"
          :items="deviceItems"
          placeholder="Default microphone"
          icon="i-lucide-mic"
          size="sm"
          class="w-full sm:w-48"
          aria-label="Microphone"
          @update:model-value="(value: string) => voice.setInputDevice(value)"
        />
      </div>

      <div v-if="voice.notice.value" class="mt-2 flex items-start gap-2 text-xs text-muted">
        <UIcon name="i-lucide-info" class="mt-0.5 size-3.5 shrink-0" />
        <span class="min-w-0 flex-1">{{ voice.notice.value }}</span>
      </div>

      <div v-if="voice.utterance.value" class="mt-2 flex items-start gap-2 text-sm">
        <UIcon name="i-lucide-ear" class="mt-0.5 size-4 shrink-0 text-muted" />
        <span class="min-w-0 flex-1 text-muted">{{ voice.utterance.value }}</span>
        <UButton label="Send" size="xs" color="neutral" variant="subtle" @click="voice.sendHeld()" />
        <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Discard" @click="voice.discardHeld()" />
      </div>

      <div v-if="voice.spokenText.value && voice.speakEnabled.value" class="mt-2 flex items-start gap-2 text-sm">
        <UIcon name="i-lucide-audio-lines" class="mt-0.5 size-4 shrink-0 text-primary" />
        <span class="min-w-0 flex-1 text-muted line-clamp-2">{{ voice.spokenText.value }}</span>
      </div>
    </div>
  </div>
</template>
