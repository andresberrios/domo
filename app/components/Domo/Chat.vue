<script setup lang="ts">
/**
 * The chat surface for one session. Subscribes to the entity's durable
 * stream (`useSessionStream`), projects it to AI SDK `UIMessage[]`
 * (`projectSessionMessages`), and renders with Nuxt UI's `UChatMessages`
 * — the design's "reuse the chat template wholesale" path, now that the
 * UI transcript is standardized on the `UIMessage` shape.
 *
 * Sending / aborting go through the `sessions.*` procedures; the result
 * flows back in via the durable stream (no optimistic echo needed — the
 * inbox prompt and assistant turn both arrive on the stream).
 */
import type { ChatStatus } from 'ai'
import { projectSessionMessages } from '~/utils/sessionMessages'

const props = defineProps<{
  sessionId: string
  entityId: string | null
}>()

const entityRef = computed(() => props.entityId)
const { events, sessionMeta, inbox, ready, error } =
  useSessionStream(entityRef)

const messages = computed(() =>
  projectSessionMessages(events.value, inbox.value),
)

const status = computed<ChatStatus>(() => {
  const s = sessionMeta.value?.status
  if (s === 'error') return 'error'
  if (s === 'running' || s === 'pending-approval') return 'streaming'
  return 'ready'
})

const input = ref('')
const sending = ref(false)
const actionError = ref<string | null>(null)

async function onSubmit(e: Event) {
  e.preventDefault()
  const text = input.value.trim()
  if (!text || sending.value) return
  sending.value = true
  actionError.value = null
  try {
    await apiClient.sessions.prompt.call({ id: props.sessionId, text })
    input.value = ''
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  } finally {
    sending.value = false
  }
}

async function onStop() {
  try {
    await apiClient.sessions.abort.call({ id: props.sessionId })
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div
      v-if="error"
      class="px-4 py-2 text-xs text-error border-b border-default shrink-0"
    >
      Session stream unavailable: {{ error }}
    </div>

    <div class="flex-1 min-h-0 overflow-hidden">
      <UChatMessages
        :messages="messages"
        :status="status"
        should-auto-scroll
        :spacing-offset="120"
        class="h-full px-4"
      >
        <template #indicator>
          <UChatShimmer text="Working…" class="text-sm" />
        </template>
        <template #content="{ message }">
          <DomoChatMessageContent :message="message" />
        </template>
      </UChatMessages>

      <div
        v-if="!ready && !error && messages.length === 0"
        class="p-6 text-muted text-sm"
      >
        Connecting to session…
      </div>
    </div>

    <div class="shrink-0 p-3 border-t border-default">
      <p v-if="actionError" class="text-xs text-error mb-2">
        {{ actionError }}
      </p>
      <UChatPrompt
        v-model="input"
        :placeholder="
          status === 'streaming'
            ? 'Agent is working — send to queue, or stop'
            : 'Message the agent…'
        "
        variant="subtle"
        @submit="onSubmit"
      >
        <template #footer>
          <div class="flex-1" />
          <UChatPromptSubmit
            :status="status"
            color="neutral"
            size="sm"
            @stop="onStop"
          />
        </template>
      </UChatPrompt>
    </div>
  </div>
</template>
