/**
 * Minimal in-process change bus — the unified reactivity spine
 * (Decided #8). One singleton, called from every post-write chokepoint;
 * SSE / live subscribers attach handlers and the singleton fans out.
 *
 * Step 1 wires the **chat fine path**, on two channels:
 *
 *  - `session-event` — every durable `session_events` append. Consumers
 *    catch up via the SQLite seq cursor (`?since=<lastSeq>`), so a
 *    missed emit is recovered idempotently on reconnect.
 *  - `session-partial` — **live-only** streaming assistant deltas
 *    (coalesced from `--include-partial-messages`). NOT persisted —
 *    the complete `assistant` envelope arrives on the durable channel
 *    and supersedes the partial in the adapter. A reconnecting browser
 *    that missed an in-flight partial just doesn't see it; the next
 *    flush (or the final `assistant` row) is the source of truth.
 *
 * The coarse path (`{table,id,op}` → procedure refetch) and the
 * singleton browser SSE client land in step 2 when the rail poll is
 * deleted.
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

type SessionEventHandler = (notice: SessionEventNotice) => void
type SessionPartialHandler = (frame: SessionPartialFrame) => void

class ChangeBus {
  private sessionEventHandlers = new Map<string, Set<SessionEventHandler>>()
  private sessionPartialHandlers = new Map<string, Set<SessionPartialHandler>>()

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
}

let _bus: ChangeBus | null = null

export function changeBus(): ChangeBus {
  if (!_bus) _bus = new ChangeBus()
  return _bus
}
