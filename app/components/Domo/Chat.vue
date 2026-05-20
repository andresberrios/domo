<script setup lang="ts">
/**
 * The chat surface for one session. Subscribes to the in-process engine's
 * `/api/live` SSE (`useSessionStream`), projects it to AI SDK `UIMessage[]`
 * (`projectSessionMessages`), and renders with Nuxt UI's `UChatMessages`
 * — the design's "reuse the chat template wholesale" path, now that the
 * UI transcript is standardized on the `UIMessage` shape.
 *
 * Sending / aborting go through the `sessions.*` procedures; the result
 * flows back in via the SSE (no optimistic echo needed — the engine
 * appends a durable `prompt` event so both ends agree on send order).
 */
import type { ChatStatus, UIMessage } from 'ai'
import { projectSessionMessages } from '~/utils/sessionMessages'

const props = defineProps<{
  sessionId: string
}>()

const sessionRef = computed(() => props.sessionId)
const { events, partial, pendingDiffs, status: streamStatus, ready, error } =
  useSessionStream(sessionRef)

// Parked agent edits awaiting the user, oldest first. Folded client-side
// from the SSE-replayed `pending_diff`/`diff_decision` events, so cards
// survive client/server restart and show on any device.
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
watch([() => events.value.length, () => streamStatus.value], scheduleMarkViewed)
onBeforeUnmount(() => {
  if (viewedTimer) clearTimeout(viewedTimer)
})

const messages = computed(() =>
  projectSessionMessages(events.value, partial.value),
)

const status = computed<ChatStatus>(() => {
  const s = streamStatus.value
  if (s === 'error') return 'error'
  if (s === 'active' || s === 'pending-approval') return 'streaming'
  return 'ready'
})

const input = ref('')
const sending = ref(false)
const actionError = ref<string | null>(null)
const inputRef = useTemplateRef<{ focus: () => void }>('inputRef')

// Per-session edit-approval policy (Decided #22). `null` = inherit the
// operator default (`config.claude.approvalMode`, itself defaulting to
// `manual`). Plain DB read/write — the entity re-reads the effective
// mode at the start of each turn, so a change applies next turn.
// `'default'` is the UI sentinel for "no override → inherit the
// operator default"; it maps to a `null` approvalMode on the wire
// (USelect values must be primitives, not `null`).
type ApprovalChoice = 'manual' | 'auto' | 'passthrough'
const approvalValue = ref<ApprovalChoice | 'default'>('default')
const approvalItems = [
  { label: 'Approvals: Default', value: 'default' },
  { label: 'Approvals: Manual (review each edit)', value: 'manual' },
  { label: 'Approvals: Auto-accept edits', value: 'auto' },
  { label: 'Approvals: Use my Claude settings', value: 'passthrough' },
]
async function loadApprovalMode() {
  try {
    const s = await apiClient.sessions.get.call({ id: props.sessionId })
    approvalValue.value = s.approvalMode ?? 'default'
  } catch {
    /* non-fatal — selector just stays on Default */
  }
}
async function onApprovalChange(v: string) {
  approvalValue.value = v as ApprovalChoice | 'default'
  try {
    await apiClient.sessions.setApprovalMode.call({
      id: props.sessionId,
      approvalMode: v === 'default' ? null : (v as ApprovalChoice),
    })
  } catch (e) {
    actionError.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(loadApprovalMode)
watch(() => props.sessionId, loadApprovalMode)

// ⌘I focuses the prompt from anywhere in the session view (incl. while
// the editor/terminal has focus — hence usingInput).
defineShortcuts({
  meta_i: { usingInput: true, handler: () => inputRef.value?.focus() },
})

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

// Step 5 group-chat: post the input as a chat event without triggering
// a turn. Useful when multiple humans are in the session and a comment
// shouldn't wake the agent (the next @agent / Send catches up via the
// engine's backlog fold).
async function onChatOnly() {
  const text = input.value.trim()
  if (!text || sending.value) return
  sending.value = true
  actionError.value = null
  try {
    await apiClient.sessions.chat.call({ id: props.sessionId, text })
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

    <!--
      This wrapper MUST be the scroll container. `UChatMessages` is not
      itself scrollable — it scrolls the nearest ancestor whose computed
      overflow-y is auto|scroll (Nuxt UI `getScrollParent`). With
      `overflow-hidden` here the search walked up to AppShell's center
      body, but `DomoChat` is `h-full` and clips internally so that
      ancestor's scrollHeight == clientHeight — nothing scrolls and the
      transcript is clipped/unreachable (bit us on short mobile
      viewports). `overflow-y-auto` makes this bounded `flex-1 min-h-0`
      region the scroll parent; input + diff cards stay pinned below.
    -->
    <div class="flex-1 min-h-0 overflow-y-auto">
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
      <div class="flex items-center justify-between mb-2 gap-2">
        <UButton
          size="xs"
          variant="ghost"
          color="neutral"
          icon="i-lucide-message-square"
          :disabled="sending || !input.trim()"
          title="Post as chat (don't trigger the agent — @agent or Send does)"
          @click="onChatOnly"
        >
          Chat only
        </UButton>
        <USelect
          :model-value="approvalValue"
          :items="approvalItems"
          size="xs"
          variant="ghost"
          color="neutral"
          class="text-xs"
          :ui="{ base: 'text-muted' }"
          @update:model-value="onApprovalChange"
        />
      </div>
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
