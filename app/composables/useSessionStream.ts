/**
 * Subscribe to a session's `/api/live` SSE — the in-process engine's
 * change-bus / chat seq-tail (Decided #8). Exposes the transcript and
 * derived view-state as Vue-reactive refs.
 *
 * Wire model: two SSE event types share one connection.
 *
 *  - `session-event` (durable rows): replayed once at connect since
 *    `?since=0`, then streamed live as the engine appends. `seq` is the
 *    primary key; reconnect with `?since=<lastSeq>` is lossless.
 *  - `partial` (live-only): the latest coalesced streaming assistant
 *    delta. Not replayed on reconnect — partials are transient by design;
 *    the complete `assistant` event arrives on the durable channel and
 *    supersedes the partial bubble in the adapter (matched by
 *    Anthropic `message.id`).
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

interface WireEvent {
  sessionId?: string
  seq: number
  type: string
  payload: Record<string, unknown>
  createdAt: number
}

interface WirePartial {
  sessionId?: string
  messageId: string
  text: string
  thinking: string
  createdAt: number
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
  let teardown: (() => void) | null = null

  // Per-connection scratch state (rebuilt on every (re)connect).
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

  function applyRow(wire: WireEvent): void {
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

  function applyPartial(wire: WirePartial): void {
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

  function connect(id: string): void {
    if (!import.meta.client) return
    bySeq = new Map<number, EventRow>()
    diffMap = new Map<string, PendingDiffRow>()
    finalizedMsgIds = new Set<string>()
    let highWater = 0
    let es: EventSource | null = null

    const open = (since: number): EventSource => {
      const url = `/api/live?sessionId=${encodeURIComponent(id)}&since=${since}`
      const source = new EventSource(url, { withCredentials: true })
      source.addEventListener('session-event', (ev) => {
        if (disposed || sessionId.value !== id) return
        let wire: WireEvent | null = null
        try {
          wire = JSON.parse((ev as MessageEvent).data) as WireEvent
        } catch {
          return
        }
        if (!wire || typeof wire.seq !== 'number') return
        if (wire.seq > highWater) highWater = wire.seq
        applyRow(wire)
        publish()
      })
      source.addEventListener('partial', (ev) => {
        if (disposed || sessionId.value !== id) return
        let wire: WirePartial | null = null
        try {
          wire = JSON.parse((ev as MessageEvent).data) as WirePartial
        } catch {
          return
        }
        if (!wire || typeof wire.messageId !== 'string') return
        applyPartial(wire)
      })
      source.addEventListener('snapshot-end', () => {
        if (disposed || sessionId.value !== id) return
        ready.value = true
        publish()
      })
      source.addEventListener('error', () => {
        if (disposed || sessionId.value !== id) return
        // EventSource auto-reconnects; expose the transient error but
        // don't tear down. If the connection stays broken `ready` stays
        // true (we already have the snapshot) and `error` is visible.
        error.value = 'live connection interrupted; retrying…'
        // Force a manual restart with the latest high-water so we don't
        // re-replay the whole transcript on every blip.
        try {
          source.close()
        } catch {
          /* already closed */
        }
        if (!disposed && sessionId.value === id) {
          setTimeout(() => {
            if (disposed || sessionId.value !== id) return
            es = open(highWater)
          }, 1000)
        }
      })
      source.onopen = () => {
        if (!disposed && sessionId.value === id) error.value = null
      }
      return source
    }

    es = open(0)
    teardown = () => {
      try {
        es?.close()
      } catch {
        /* already closed */
      }
    }
  }

  watch(
    sessionId,
    (id) => {
      reset()
      if (id) connect(id)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    teardown?.()
  })

  return { events, partial, pendingDiffs, status, ready, error }
}
