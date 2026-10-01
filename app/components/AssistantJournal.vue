<script setup lang="ts">
import type { AgentSession, Assistant } from '~~/shared/types'
import { HANDOFF_REASON_LABELS } from '~~/shared/assistants'

/**
 * An assistant's sessions, newest first, like the pages of a journal: when
 * each began and why, the note it started from, how full it got. Each one is
 * an ordinary coding session underneath, and opens as one.
 */
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ assistant: Assistant, sessions: AgentSession[] }>()

const { bySession } = useHandoffEvents()

const pages = computed(() =>
  props.sessions
    .map((session, index) => ({
      session,
      number: index + 1,
      current: session.id === props.assistant.currentSessionId,
      handoff: bySession.value.get(session.id) ?? null,
      context: session.usage?.context ?? null
    }))
    .reverse()
)
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="`${assistant.name}'s journal`"
    description="Every session it has been through. Each one is an ordinary coding session you can open."
  >
    <template #body>
      <ol class="space-y-3">
        <li
          v-for="page in pages"
          :key="page.session.id"
          class="rounded-lg border border-default p-3"
          :class="page.current ? 'ring-1 ring-primary/40' : undefined"
        >
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">Session {{ page.number }}</span>
            <UBadge v-if="page.current" label="Current" color="primary" variant="subtle" size="sm" />
            <StatusDot v-if="page.current" :status="page.session.status" />
            <span class="ms-auto text-xs text-dimmed">{{ relativeTime(page.session.createdAt) }}</span>
          </div>
          <p class="mt-1 text-xs text-muted">
            {{ page.handoff
              ? `Started because ${HANDOFF_REASON_LABELS[page.handoff.payload?.reason as keyof typeof HANDOFF_REASON_LABELS] ?? 'of a handoff'}.`
              : 'The first session.' }}
            <template v-if="page.session.model"> · {{ page.session.model }}</template>
            <template v-if="page.context?.size">
              · context {{ formatPercent(percentOf(page.context.used, page.context.size) ?? 0) }}
            </template>
          </p>
          <UCollapsible v-if="page.handoff?.payload?.note" class="mt-2">
            <UButton
              label="The note it started from"
              icon="i-lucide-notebook-pen"
              color="neutral"
              variant="link"
              size="xs"
              trailing-icon="i-lucide-chevron-down"
              class="px-0"
            />
            <template #content>
              <div class="mt-1 border-s-2 border-accented ps-3 text-sm text-muted">
                <MarkdownView :text="page.handoff.payload.note" />
              </div>
            </template>
          </UCollapsible>
          <div class="mt-2 flex justify-end">
            <UButton
              :to="`/agents/${page.session.id}`"
              label="Open session"
              trailing-icon="i-lucide-arrow-right"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="open = false"
            />
          </div>
        </li>
      </ol>
    </template>
  </USlideover>
</template>
