/**
 * Subscribe to a session's `/api/live` stream — the in-process engine's
 * change-bus / chat seq-tail (Decided #8). Exposes the transcript and
 * derived view-state as Vue-reactive refs.
 *
 * Wire model: three SSE event types share one tab-wide connection
 * (`liveBus()`):
 *
 *  - `session-event` (durable rows): replayed once at connect since
 *    `?since=<lastSeq>`, then streamed live as the engine appends. `seq`
 *    is the primary key; reconnect after a transient error resumes
 *    losslessly from the current high-water.
 *  - `partial` (live-only): the latest coalesced streaming assistant
 *    delta. Not replayed on reconnect — partials are transient by design;
 *    the complete `assistant` event arrives on the durable channel and
 *    supersedes the partial bubble in the adapter (matched by Anthropic
 *    `message.id`).
 *  - `table-change` (tab-wide coarse): not consumed here — drives the
 *    rail's `useLiveRefresh`. Shares the same connection so we don't
 *    pay for two SSE sockets per tab.
 *
 * The session **status** + the **pending-diff** queue are *derived from
 * events client-side* (no extra procedure call): `pending_diff` adds a
 * row, the matching `diff_decision` resolves it; `prompt`/assistant
 * activity → `active`; `pending_diff` without resolution →
 * `pending-approval`; `result`/`aborted` → `waiting`; `error` → `error`.
 * Restart-rejected orphans replay their auto-`diff_decision` from the
 * boot reconcile, so the card clears with no special handling.
 */
import { shallowRef, watch, onScopeDispose, type Ref } from 'vue'
import type {
  ChatSessionStatus,
  EventRow,
  PartialFrame,
  PendingDiffRow,
} from '~/utils/sessionStreamTypes'

export interface SessionStream {
  events: Ref<EventRow[]>
  partial: Ref<PartialFrame | null>
  pendingDiffs: Ref<PendingDiffRow[]>
  status: Ref<ChatSessionStatus>
  ready: Ref<boolean>
  error: Ref<string | null>
}

/**
 * Fold `pending_diff` / `diff_decision` events into the current map of
 * still-pending diffs. Idempotent (a replayed event won't double-park).
 */
function applyDiffEvent(
  rows: Map<string, PendingDiffRow>,
  evt: EventRow,
): void {
  if (evt.type === 'pending_diff') {
    const p = evt.payload as {
      callId?: unknown
      path?: unknown
      before?: unknown
      after?: unknown
      tabName?: unknown
    }
    const callId = typeof p.callId === 'string' ? p.callId : ''
    if (!callId) return
    if (rows.has(callId)) return
    rows.set(callId, {
      callId,
      path: typeof p.path === 'string' ? p.path : '',
      before: typeof p.before === 'string' ? p.before : '',
      after: typeof p.after === 'string' ? p.after : '',
      tabName: typeof p.tabName === 'string' ? p.tabName : '',
      status: 'pending',
      createdTs: evt.createdAt,
    })
    return
  }
  if (evt.type === 'diff_decision') {
    const p = evt.payload as { callId?: unknown; decision?: unknown }
    const callId = typeof p.callId === 'string' ? p.callId : ''
    if (!callId) return
    const r = rows.get(callId)
    if (!r) return
    r.status = p.decision === 'accept' ? 'accepted' : 'rejected'
  }
}

/**
 * Derive the chat status from the chronological event stream.
 * `active`/`pending-approval` map to `streaming` in the UChatMessages
 * indicator; `error` → `error`; else `ready`.
 */
function deriveStatus(
  events: EventRow[],
  pending: Map<string, PendingDiffRow>,
): ChatSessionStatus {
  for (const r of pending.values()) {
    if (r.status === 'pending') return 'pending-approval'
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]!.type
    if (t === 'result' || t === 'aborted') return 'waiting'
    if (t === 'error') return 'error'
    if (
      t === 'prompt' ||
      t === 'assistant' ||
      t === 'user' ||
      t === 'system' ||
      t === 'steer_sent'
    ) {
      return 'active'
    }
  }
  return 'waiting'
}

export function useSessionStream(
  sessionId: Ref<string | null | undefined>,
): SessionStream {
  const events = shallowRef<EventRow[]>([])
  const partial = shallowRef<PartialFrame | null>(null)
  const pendingDiffs = shallowRef<PendingDiffRow[]>([])
  const status = shallowRef<ChatSessionStatus>('waiting')
  const ready = shallowRef(false)
  const error = shallowRef<string | null>(null)

  let disposed = false
  /** Per-session teardown for the singleton subscriptions. */
  let teardown: (() => void) | null = null

  // Per-session scratch state (rebuilt on every session switch).
  let bySeq: Map<number, EventRow> | null = null
  let diffMap: Map<string, PendingDiffRow> | null = null
  let finalizedMsgIds: Set<string> | null = null

  function reset(): void {
    teardown?.()
    teardown = null
    events.value = []
    partial.value = null
    pendingDiffs.value = []
    status.value = 'waiting'
    ready.value = false
    error.value = null
    bySeq = null
    diffMap = null
    finalizedMsgIds = null
  }

  function publish(): void {
    if (!bySeq || !diffMap) return
    const sorted = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
    events.value = sorted
    pendingDiffs.value = [...diffMap.values()].sort(
      (a, b) => a.createdTs - b.createdTs,
    )
    status.value = deriveStatus(sorted, diffMap)
  }

  function applyRow(wire: {
    seq: number
    type: string
    payload: Record<string, unknown>
    createdAt: number
  }): void {
    if (!bySeq || !diffMap || !finalizedMsgIds) return
    const row: EventRow = {
      seq: wire.seq,
      type: wire.type,
      payload: wire.payload,
      createdAt: wire.createdAt,
    }
    bySeq.set(row.seq, row)
    applyDiffEvent(diffMap, row)
    // Clear the live partial bubble once its complete `assistant` lands —
    // the durable row now carries the final text/thinking/tool_use parts.
    if (row.type === 'assistant') {
      const mid = (row.payload as { message?: { id?: unknown } }).message?.id
      if (typeof mid === 'string') {
        finalizedMsgIds.add(mid)
        if (partial.value && partial.value.messageId === mid) {
          partial.value = null
        }
      }
    }
    // Turn boundaries: the partial is stale (was attached to the prior
    // message that just ended/failed/aborted).
    if (row.type === 'result' || row.type === 'aborted' || row.type === 'error') {
      partial.value = null
    }
  }

  function applyPartial(wire: {
    messageId: string
    text: string
    thinking: string
    createdAt: number
  }): void {
    if (!finalizedMsgIds) return
    // Final already landed — ignore a late partial for that message.
    if (finalizedMsgIds.has(wire.messageId)) return
    partial.value = {
      messageId: wire.messageId,
      text: wire.text,
      thinking: wire.thinking,
      createdAt: wire.createdAt,
    }
  }

  /** id we last asked the singleton to focus on — used for safe release. */
  let claimedId: string | null = null

  function connect(id: string): void {
    if (!import.meta.client) return
    bySeq = new Map<number, EventRow>()
    diffMap = new Map<string, PendingDiffRow>()
    finalizedMsgIds = new Set<string>()

    const bus = liveBus()
    // Register handlers BEFORE refocusing so we don't miss the snapshot
    // replay that fires as soon as the SSE opens with this sessionId.
    const offEvent = bus.onSessionEvent(id, (frame) => {
      if (disposed || sessionId.value !== id) return
      applyRow(frame)
      publish()
    })
    const offPartial = bus.onPartial(id, (frame) => {
      if (disposed || sessionId.value !== id) return
      applyPartial(frame)
    })
    const offSnapshotEnd = bus.onSnapshotEnd(id, () => {
      if (disposed || sessionId.value !== id) return
      ready.value = true
      publish()
    })
    const offError = bus.onError((msg) => {
      if (disposed || sessionId.value !== id) return
      error.value = msg
    })

    bus.focusSession(id)
    claimedId = id

    teardown = () => {
      offEvent()
      offPartial()
      offSnapshotEnd()
      offError()
    }
  }

  watch(
    sessionId,
    (id, prev) => {
      reset()
      if (id) {
        connect(id)
      } else if (prev && claimedId) {
        // We were focused on a session; let the singleton know nothing
        // else here cares so it can close down to the table-change-only
        // mode (or close entirely if no other subscribers). CAS: only
        // releases if the focus is still ours.
        liveBus().releaseFocusIf(claimedId)
        claimedId = null
      }
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    teardown?.()
    if (claimedId) {
      liveBus().releaseFocusIf(claimedId)
      claimedId = null
    }
  })

  return { events, partial, pendingDiffs, status, ready, error }
}
