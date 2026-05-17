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
import type { ChatStatus, UIMessage } from 'ai'
import { projectSessionMessages } from '~/utils/sessionMessages'

const props = defineProps<{
  sessionId: string
  entityId: string | null
}>()

const entityRef = computed(() => props.entityId)
const { events, sessionMeta, inbox, pendingDiffs, ready, error } =
  useSessionStream(entityRef)

// Parked agent edits awaiting the user, oldest first. Read off the durable
// collection, so they survive client/server restart and show on any
// device — the core of the resumable diff-approval requirement.
const awaitingDiffs = computed(() =>
  [...pendingDiffs.value]
    .filter((d) => d.status === 'pending')
    .sort((a, b) => a.createdTs - b.createdTs),
)

// While this session is the focused one, keep stamping the per-device
// viewed-at forward so its left-rail new-output dot stays cleared; once
// the user navigates away, later agent output advances `lastEventAt` past
// the stamp and the dot appears. Debounced — a turn emits many envelopes.
const deviceId = useDeviceId()
let viewedTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMarkViewed() {
  if (!import.meta.client) return
  if (viewedTimer) clearTimeout(viewedTimer)
  viewedTimer = setTimeout(() => {
    void apiClient.sessions.markViewed
      .call({ id: props.sessionId, deviceId })
      .catch(() => {})
  }, 600)
}
onMounted(scheduleMarkViewed)
watch(
  [() => events.value.length, () => sessionMeta.value?.status],
  scheduleMarkViewed,
)
onBeforeUnmount(() => {
  if (viewedTimer) clearTimeout(viewedTimer)
})

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
const inputRef = useTemplateRef<{ focus: () => void }>('inputRef')

/**
 * Edit-and-regenerate, pragmatic scope: pull a past user message back into
 * the prompt so the user can refine and resend. This continues the *same*
 * session (claude `--resume` keeps prior context), which matches how a
 * correction is normally issued. True edit-and-*fork* — branching the
 * durable stream + forking the native claude session at message N — is
 * deferred (see docs/initial-design.md "Reconciling Claude's session
 * file with the durable stream"): it needs durable-stream branch +
 * arbitrary-offset claude rewind primitives we haven't validated.
 */
function editMessage(message: UIMessage) {
  const text = message.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
  if (!text) return
  input.value = text
  nextTick(() => inputRef.value?.focus())
}

async function onSubmit() {
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
        <template #actions="{ message }">
          <UTooltip
            v-if="message.role === 'user'"
            text="Edit & resend"
          >
            <UButton
              icon="i-lucide-pencil"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Edit & resend"
              @click="editMessage(message)"
            />
          </UTooltip>
        </template>
      </UChatMessages>

      <div
        v-if="!ready && !error && messages.length === 0"
        class="p-6 text-muted text-sm"
      >
        Connecting to session…
      </div>
    </div>

    <div
      v-if="awaitingDiffs.length"
      class="shrink-0 px-3 pt-3 space-y-2 max-h-[55%] overflow-y-auto"
    >
      <DomoDiffApprovalCard
        v-for="d in awaitingDiffs"
        :key="d.callId"
        :session-id="sessionId"
        :diff="d"
      />
    </div>

    <div class="shrink-0 p-3 border-t border-default">
      <p v-if="actionError" class="text-xs text-error mb-2">
        {{ actionError }}
      </p>
      <DomoChatInput
        ref="inputRef"
        v-model="input"
        :session-id="sessionId"
        :status="status"
        @submit="onSubmit"
        @stop="onStop"
      />
    </div>
  </div>
</template>
