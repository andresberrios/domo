<script setup lang="ts">
/**
 * The strip under a transcript row: when it happened, to the second, and what
 * can be done with it — read it aloud. Whether every row's time shows is a
 * switch in the agent page's menu and in Settings.
 *
 * It is positioned in the empty band Nuxt UI leaves under a message, outside
 * the row's content box, so showing or hiding any of it never moves anything.
 * The time fades in under the pointer, after a tap, or always; the button
 * only ever on hover or a tap, and it takes no taps while it is invisible.
 */
const props = defineProps<{
  at: string
  side: 'left' | 'right'
  /** The time shows without a hover: the setting is on, or the row was tapped. */
  shown: boolean
  /** The row was tapped, so its button shows too. */
  revealed: boolean
  replay?: () => void
}>()

const ON_HOVER = 'opacity-0 group-hover/message:opacity-100'
const buttons = computed(() => props.revealed
  ? 'opacity-100'
  : `${ON_HOVER} pointer-events-none group-hover/message:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto`)
</script>

<template>
  <div
    class="absolute top-full translate-y-1 flex h-6 items-center gap-0.5 text-xs text-dimmed"
    :class="side === 'right' ? 'right-0 flex-row-reverse' : 'left-0'"
    data-testid="row-meta"
  >
    <time
      :datetime="at"
      :title="fullTime(at)"
      class="whitespace-nowrap px-1 tabular-nums transition-opacity"
      :class="shown ? 'opacity-100' : ON_HOVER"
      data-testid="row-time"
    >{{ clockTime(at) }}</time>
    <UButton
      v-if="replay"
      icon="i-lucide-volume-2"
      color="neutral"
      variant="ghost"
      size="xs"
      aria-label="Read this aloud"
      title="Read this aloud"
      class="text-dimmed transition-opacity"
      :class="buttons"
      @click.stop="replay()"
    />
  </div>
</template>
