<script setup lang="ts">
import type { AgentSession } from '~~/shared/types'

/**
 * Why this session cannot be started, on the session itself.
 *
 * Losing an environment does not hide the sessions that ran in it — they stay
 * on the list, and their transcripts stay readable — so something has to say
 * what happened, or the page would be a transcript with a composer that only
 * ever errored. That is this, and it is the reason the composer and the Start
 * button are not rendered at all rather than being disabled: a control you
 * cannot use is worse than one that is not there, once the sentence above it
 * explains why.
 *
 * The reason comes from the same pure rule the server refuses with
 * (`shared/retention.ts`), so it cannot drift from what a prompt would answer.
 */
defineProps<{ session: AgentSession, reason: string }>()
</script>

<template>
  <div class="mx-auto w-full max-w-3xl shrink-0 py-2">
    <UAlert
      color="neutral"
      variant="subtle"
      icon="i-lucide-archive"
      title="This session can no longer run"
    >
      <template #description>
        <p>{{ reason }}</p>
        <p class="mt-1 text-dimmed">
          Everything below is kept and stays readable. Nothing can be sent to it, and no schedule or
          other agent can wake it.
        </p>
      </template>
    </UAlert>
  </div>
</template>
