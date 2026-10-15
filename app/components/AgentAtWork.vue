<script setup lang="ts">
import { useDocumentVisibility } from '@vueuse/core'
import type { AgentActivity } from '~/utils/agentTranscript'

/**
 * The agent at work, under the last row of a transcript while a turn runs:
 * its robot bobbing over what it is doing — a wrench and a gear with sparks
 * for a tool, thought dots for thinking, a pencil and typing dots for
 * writing. The transcript draws it in the space it keeps empty below the
 * last row, out of the flow, so it never moves a row or counts as content.
 *
 * Decoration: the page's status already says "Working" to a screen reader,
 * and a live region here would announce every tool call.
 *
 * Transforms and opacity only, and every loop stops while the tab is hidden.
 * With reduced motion the scene holds still and only breathes.
 */
defineProps<{ activity: AgentActivity }>()

const visibility = useDocumentVisibility()

const LABELS: Record<AgentActivity, string> = {
  tool: 'Tinkering',
  thinking: 'Thinking',
  writing: 'Writing'
}
</script>

<template>
  <div
    class="at-work flex items-center gap-2 text-xs text-dimmed"
    :class="{ 'at-work-paused': visibility === 'hidden' }"
    aria-hidden="true"
    data-testid="agent-at-work"
  >
    <!-- The same width as a row's avatar, so the robot stands where the agent's replies start. -->
    <span class="relative flex size-8 shrink-0 items-center justify-center">
      <UIcon name="i-lucide-bot" class="at-work-bob size-5 text-primary" />
    </span>

    <!-- One width for every scene (the widest), so the words beside it stay put as it changes. -->
    <span class="relative flex h-5 w-12 items-center justify-center">
      <template v-if="activity === 'tool'">
        <UIcon name="i-lucide-wrench" class="at-work-wrench size-3.5 text-muted" />
        <UIcon name="i-lucide-cog" class="at-work-cog ms-1 size-4 text-muted" />
        <UIcon name="i-lucide-sparkle" class="at-work-spark absolute start-3 -top-1 size-2.5 text-warning" />
        <UIcon name="i-lucide-sparkle" class="at-work-spark at-work-later absolute start-8 top-3.5 size-2 text-primary" />
      </template>
      <template v-else-if="activity === 'writing'">
        <UIcon name="i-lucide-pencil" class="at-work-pencil size-3.5 text-muted" />
        <span class="ms-1.5 flex items-end gap-0.5">
          <span v-for="dot in 3" :key="dot" class="at-work-type size-1 rounded-full bg-current" :style="{ animationDelay: `${dot * 140}ms` }" />
        </span>
      </template>
      <template v-else>
        <span class="flex items-end gap-1">
          <span
            v-for="dot in 3"
            :key="dot"
            class="at-work-think rounded-full bg-current"
            :class="['size-1', 'size-1.5', 'size-2'][dot - 1]"
            :style="{ animationDelay: `${dot * 220}ms` }"
          />
        </span>
        <UIcon name="i-lucide-lightbulb" class="at-work-bulb ms-1.5 size-3.5 text-warning" />
      </template>
    </span>

    <Transition name="swap">
      <span :key="activity">{{ LABELS[activity] }}…</span>
    </Transition>
  </div>
</template>

<style scoped>
.at-work-bob { animation: at-work-bob 1.4s ease-in-out infinite alternate; }
.at-work-wrench { transform-origin: 80% 80%; animation: at-work-wrench 0.9s ease-in-out infinite alternate; }
.at-work-cog { animation: at-work-turn 2.4s linear infinite; }
.at-work-spark { opacity: 0; animation: at-work-spark 0.9s ease-out infinite; }
.at-work-later { animation-delay: 0.45s; }
.at-work-pencil { transform-origin: 20% 80%; animation: at-work-scribble 0.5s ease-in-out infinite alternate; }
.at-work-type { animation: at-work-type 0.9s ease-in-out infinite; }
.at-work-think { opacity: 0.25; animation: at-work-think 1.3s ease-in-out infinite; }
.at-work-bulb { animation: at-work-flicker 2.6s ease-in-out infinite; }

.at-work-paused,
.at-work-paused * { animation-play-state: paused !important; }

@keyframes at-work-bob { from { transform: translateY(1px); } to { transform: translateY(-1.5px) rotate(-4deg); } }
@keyframes at-work-wrench { from { transform: rotate(-30deg); } to { transform: rotate(18deg); } }
@keyframes at-work-turn { to { transform: rotate(360deg); } }
@keyframes at-work-spark {
  0%, 40% { opacity: 0; transform: scale(0.4); }
  55% { opacity: 1; transform: scale(1.1) rotate(45deg); }
  100% { opacity: 0; transform: scale(0.6) rotate(90deg); }
}
@keyframes at-work-scribble { from { transform: translateX(-1px) rotate(-8deg); } to { transform: translateX(2px) rotate(6deg); } }
@keyframes at-work-type { 0%, 60%, 100% { transform: translateY(0); opacity: 0.4; } 30% { transform: translateY(-3px); opacity: 1; } }
@keyframes at-work-think { 0%, 100% { opacity: 0.25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
@keyframes at-work-flicker { 0%, 70%, 100% { opacity: 0.5; } 80% { opacity: 1; } 85% { opacity: 0.6; } 90% { opacity: 1; } }
@keyframes at-work-breathe { from { opacity: 0.45; } to { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .at-work-bob, .at-work-wrench, .at-work-cog, .at-work-pencil, .at-work-type, .at-work-think { animation: none; }
  .at-work-spark { animation: none; opacity: 0; }
  .at-work-bulb { animation: none; }
  .at-work { animation: at-work-breathe 1.6s ease-in-out infinite alternate; }
}
</style>
