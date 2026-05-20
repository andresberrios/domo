/**
 * In-process change bus — the unified reactivity spine (Decided #8). One
 * singleton, called from every post-write chokepoint; SSE / live
 * subscribers attach handlers and the singleton fans out.
 *
 * Three channels, mirroring the three SSE event types on `/api/live`:
 *
 *  - `session-event` — every durable `session_events` append (chat fine
 *    path). Consumers catch up via the SQLite seq cursor
 *    (`?since=<lastSeq>`), so a missed emit is recovered idempotently
 *    on reconnect.
 *  - `session-partial` — **live-only** streaming assistant deltas
 *    (coalesced from `--include-partial-messages`). NOT persisted — the
 *    complete `assistant` envelope arrives on the durable channel and
 *    supersedes the partial in the adapter. A reconnecting browser that
 *    missed an in-flight partial just doesn't see it; the next flush
 *    (or the final `assistant` row) is the source of truth.
 *  - `table-change` — coarse `{table,id,op}` notices fired from the
 *    helper-layer writes in `lib/{sessions,envs,projects}.ts`. The
 *    browser `useLiveRefresh` composable subscribes a `useCall.refresh()`
 *    to this topic and refetches whenever a matching write lands. There
 *    is no replay — the consumer's existing `useCall` data is the
 *    snapshot; a missed notice on reconnect means we may serve stale
 *    data for a brief window until the next change. Idempotent by
 *    construction (refetching twice produces the same result).
 *
 * The chat fine path landed with step 1 (the chat is unusable without
 * it). The coarse path lands with step 2 — same singleton, same SSE
 * endpoint, one tab-wide browser client multiplexes all three shapes.
 */

export interface SessionEventNotice {
  sessionId: string
  seq: number
  /** Cheap hint for filtering; full row is read by the consumer via seq. */
  type: string
}

export interface SessionPartialFrame {
  sessionId: string
  /** Anthropic `message.id` — the bubble id the adapter joins on. */
  messageId: string
  /** Cumulative text so far (not a delta — the coalescer accumulates). */
  text: string
  /** Cumulative thinking content so far. */
  thinking: string
  createdAt: number
}

/**
 * Tables the rail / overview composables care about. Kept narrow on
 * purpose — only mutate-and-list shapes belong here. The chat surface's
 * per-session state has its own (durable) channel and is not driven by
 * this notice.
 */
export type TableName = 'projects' | 'envs' | 'sessions'

export interface TableChangeNotice {
  table: TableName
  /** Primary key of the affected row. */
  id: string
  op: 'insert' | 'update' | 'delete'
}

type SessionEventHandler = (notice: SessionEventNotice) => void
type SessionPartialHandler = (frame: SessionPartialFrame) => void
type TableChangeHandler = (notice: TableChangeNotice) => void

class ChangeBus {
  private sessionEventHandlers = new Map<string, Set<SessionEventHandler>>()
  private sessionPartialHandlers = new Map<string, Set<SessionPartialHandler>>()
  private tableChangeHandlers = new Set<TableChangeHandler>()

  subscribeSessionEvents(
    sessionId: string,
    handler: SessionEventHandler,
  ): () => void {
    let set = this.sessionEventHandlers.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionEventHandlers.set(sessionId, set)
    }
    set.add(handler)
    return () => {
      const s = this.sessionEventHandlers.get(sessionId)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) this.sessionEventHandlers.delete(sessionId)
    }
  }

  emitSessionEvent(notice: SessionEventNotice): void {
    const set = this.sessionEventHandlers.get(notice.sessionId)
    if (!set) return
    for (const h of set) {
      try {
        h(notice)
      } catch {
        /* one bad subscriber must not block the rest */
      }
    }
  }

  subscribeSessionPartials(
    sessionId: string,
    handler: SessionPartialHandler,
  ): () => void {
    let set = this.sessionPartialHandlers.get(sessionId)
    if (!set) {
      set = new Set()
      this.sessionPartialHandlers.set(sessionId, set)
    }
    set.add(handler)
    return () => {
      const s = this.sessionPartialHandlers.get(sessionId)
      if (!s) return
      s.delete(handler)
      if (s.size === 0) this.sessionPartialHandlers.delete(sessionId)
    }
  }

  emitSessionPartial(frame: SessionPartialFrame): void {
    const set = this.sessionPartialHandlers.get(frame.sessionId)
    if (!set) return
    for (const h of set) {
      try {
        h(frame)
      } catch {
        /* one bad subscriber must not block the rest */
      }
    }
  }

  subscribeTableChanges(handler: TableChangeHandler): () => void {
    this.tableChangeHandlers.add(handler)
    return () => {
      this.tableChangeHandlers.delete(handler)
    }
  }

  emitTableChange(notice: TableChangeNotice): void {
    for (const h of this.tableChangeHandlers) {
      try {
        h(notice)
      } catch {
        /* one bad subscriber must not block the rest */
      }
    }
  }
}

let _bus: ChangeBus | null = null

export function changeBus(): ChangeBus {
  if (!_bus) _bus = new ChangeBus()
  return _bus
}
