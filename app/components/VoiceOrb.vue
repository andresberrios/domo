<script setup lang="ts">
const props = defineProps<{
  state: 'offline' | 'connecting' | 'live' | 'error'
  listening: boolean
  speaking: boolean
  inputLevel: number
  outputLevel: number
}>()

/** The orb breathes with whoever is talking, so silence is obvious. */
const scale = computed(() => {
  const level = props.speaking ? props.outputLevel : props.listening ? props.inputLevel : 0
  return 1 + Math.min(0.35, level * 0.9)
})

const ring = computed(() => {
  if (props.state === 'error') return 'bg-error/15 text-error ring-error/30'
  if (props.speaking) return 'bg-primary/20 text-primary ring-primary/40'
  if (props.listening) return 'bg-primary/10 text-primary ring-primary/25'
  if (props.state === 'live') return 'bg-elevated text-muted ring-accented'
  return 'bg-elevated text-dimmed ring-accented'
})

const icon = computed(() => {
  if (props.state === 'error') return 'i-lucide-triangle-alert'
  if (props.speaking) return 'i-lucide-audio-lines'
  if (props.listening) return 'i-lucide-mic'
  return 'i-lucide-mic-off'
})
</script>

<template>
  <div class="relative flex size-32 items-center justify-center">
    <div
      class="absolute inset-0 rounded-full ring-1 transition-all duration-100 ease-out"
      :class="ring"
      :style="{ transform: `scale(${scale})` }"
    />
    <div
      v-if="listening || speaking"
      class="absolute inset-0 animate-ping rounded-full ring-1 ring-primary/20"
      style="animation-duration: 2.4s"
    />
    <UIcon :name="icon" class="relative size-9" :class="state === 'error' ? 'text-error' : 'text-primary'" />
  </div>
</template>
