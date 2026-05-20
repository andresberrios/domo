/**
 * Tab-wide singleton client for `/api/live` (Decided #8). One
 * EventSource per browser tab; multiplexes all three SSE event types:
 *
 *  - `session-event` + `partial` + `snapshot-end` for the currently
 *    **focused** session (whichever chat surface is mounted; the user
 *    only has one chat open at a time so a single focus pointer is
 *    enough). Switching focus tears the connection down and reopens
 *    with the new `?sessionId=` — the new session starts replay from
 *    `since=0`.
 *  - `table-change` (`{table,id,op}`) — tab-wide, always delivered.
 *    Composables like `useLiveRefresh` use this to refetch `useCall`
 *    data when an underlying row changes.
 *
 * Lifecycle: first subscriber opens the connection (lazily, on the
 * next tick after registration so handlers can attach synchronously);
 * last unsubscribe closes it. Transient EventSource errors are surfaced
 * via `onError(msg)` and auto-reconnected after ~1 s from the current
 * high-water seq so the chat doesn't double-replay its transcript on
 * every blip.
 *
 * `useSessionStream` and `useLiveRefresh` are the two consumers — the
 * singleton itself is intentionally framework-agnostic; the Vue wrappers
 * map handler callbacks onto Vue refs.
 */
import type { TableName } from '~~/server/lib/changeBus'

export interface LiveSessionEventFrame {
  sessionId: string
  seq: number
  type: string
  payload: Record<string, unknown>
  createdAt: number
}

export interface LivePartialFrame {
  sessionId: string
  messageId: string
  text: string
  thinking: string
  createdAt: number
}

export interface LiveTableChangeFrame {
  table: TableName
  id: string
  op: 'insert' | 'update' | 'delete'
}

type SessionEventHandler = (frame: LiveSessionEventFrame) => void
type PartialHandler = (frame: LivePartialFrame) => void
type SnapshotEndHandler = (highWater: number) => void
type ErrorHandler = (message: string | null) => void
type TableChangeHandler = (frame: LiveTableChangeFrame) => void

class LiveBus {
  private es: EventSource | null = null
  private focusedSessionId: string | null = null
  /** Seq high-water on the current connection — drives resume-after-error. */
  private highWater = 0
  private currentError: string | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Defer the first `openConnection` to the next microtask so the
   * caller can register handlers synchronously *before* the snapshot
   * replay starts arriving. EventSource itself is async so this is
   * really only paranoia, but it's free.
   */
  private openScheduled = false

  private sessionEventHandlers = new Map<string, Set<SessionEventHandler>>()
  private partialHandlers = new Map<string, Set<PartialHandler>>()
  private snapshotEndHandlers = new Map<string, Set<SnapshotEndHandler>>()
  private errorHandlers = new Set<ErrorHandler>()
  private tableChangeHandlers = new Set<TableChangeHandler>()

  /**
   * Point the connection at a session (or detach with `null`). A change
   * always restarts the SSE — the new session replays from `since=0`,
   * so existing handlers for the new id receive the full snapshot.
   */
  focusSession(sessionId: string | null): void {
    if (this.focusedSessionId === sessionId) return
    this.focusedSessionId = sessionId
    this.highWater = 0
    this.reopen()
  }

  /**
   * Compare-and-set release: tear down focus only if the singleton is
   * still focused on `sessionId`. Lets a component safely yield focus
   * on unmount without clobbering another component that already
   * re-focused the bus on a different session (Nuxt page transitions
   * can mount the new chat before the old's `onScopeDispose` fires).
   */
  releaseFocusIf(sessionId: string): void {
    if (this.focusedSessionId === sessionId) this.focusSession(null)
  }

  /** Read-only view; primarily for tests / debug. */
  get focusedSession(): string | null {
    return this.focusedSessionId
  }

  /** Subscribe handler to `session-event` frames for `sessionId`. */
  onSessionEvent(sessionId: string, h: SessionEventHandler): () => void {
    return this.subscribe(this.sessionEventHandlers, sessionId, h)
  }

  /** Subscribe handler to `partial` frames for `sessionId`. */
  onPartial(sessionId: string, h: PartialHandler): () => void {
    return this.subscribe(this.partialHandlers, sessionId, h)
  }

  /** Subscribe handler to `snapshot-end` for `sessionId`. */
  onSnapshotEnd(sessionId: string, h: SnapshotEndHandler): () => void {
    return this.subscribe(this.snapshotEndHandlers, sessionId, h)
  }

  /** Subscribe handler to transient connection-error messages. */
  onError(h: ErrorHandler): () => void {
    this.errorHandlers.add(h)
    this.scheduleEnsureOpen()
    // Replay the current error state synchronously so a late subscriber
    // sees an in-progress connection break.
    if (this.currentError !== null) {
      try {
        h(this.currentError)
      } catch {
        /* swallow */
      }
    }
    return () => {
      this.errorHandlers.delete(h)
      this.scheduleMaybeClose()
    }
  }

  /** Subscribe handler to `table-change` frames (tab-wide). */
  onTableChange(h: TableChangeHandler): () => void {
    this.tableChangeHandlers.add(h)
    this.scheduleEnsureOpen()
    return () => {
      this.tableChangeHandlers.delete(h)
      this.scheduleMaybeClose()
    }
  }

  private subscribe<H>(
    map: Map<string, Set<H>>,
    sessionId: string,
    h: H,
  ): () => void {
    let set = map.get(sessionId)
    if (!set) {
      set = new Set()
      map.set(sessionId, set)
    }
    set.add(h)
    this.scheduleEnsureOpen()
    return () => {
      const s = map.get(sessionId)
      if (!s) return
      s.delete(h)
      if (s.size === 0) map.delete(sessionId)
      this.scheduleMaybeClose()
    }
  }

  private hasSubscribers(): boolean {
    if (this.tableChangeHandlers.size > 0) return true
    if (this.errorHandlers.size > 0) return true
    for (const s of this.sessionEventHandlers.values()) if (s.size > 0) return true
    for (const s of this.partialHandlers.values()) if (s.size > 0) return true
    for (const s of this.snapshotEndHandlers.values()) if (s.size > 0) return true
    return false
  }

  private scheduleEnsureOpen(): void {
    if (this.openScheduled) return
    if (this.es && this.es.readyState <= 1) return
    this.openScheduled = true
    queueMicrotask(() => {
      this.openScheduled = false
      if (!this.hasSubscribers()) return
      if (this.es && this.es.readyState <= 1) return
      this.openConnection()
    })
  }

  private scheduleMaybeClose(): void {
    queueMicrotask(() => {
      if (this.hasSubscribers()) return
      this.close()
    })
  }

  private reopen(): void {
    this.close()
    this.scheduleEnsureOpen()
  }

  private openConnection(): void {
    if (!import.meta.client) return
    const sid = this.focusedSessionId
    const params = new URLSearchParams()
    if (sid) params.set('sessionId', sid)
    params.set('since', String(this.highWater))
    const es = new EventSource(`/api/live?${params.toString()}`, {
      withCredentials: true,
    })
    this.es = es

    es.addEventListener('session-event', (ev) => {
      let wire: LiveSessionEventFrame | null = null
      try {
        wire = JSON.parse((ev as MessageEvent).data) as LiveSessionEventFrame
      } catch {
        return
      }
      if (!wire || typeof wire.seq !== 'number') return
      if (wire.seq > this.highWater) this.highWater = wire.seq
      const set = this.sessionEventHandlers.get(wire.sessionId)
      if (!set) return
      for (const h of set) {
        try {
          h(wire)
        } catch {
          /* one bad subscriber must not block the rest */
        }
      }
    })

    es.addEventListener('partial', (ev) => {
      let wire: LivePartialFrame | null = null
      try {
        wire = JSON.parse((ev as MessageEvent).data) as LivePartialFrame
      } catch {
        return
      }
      if (!wire || typeof wire.messageId !== 'string') return
      const set = this.partialHandlers.get(wire.sessionId)
      if (!set) return
      for (const h of set) {
        try {
          h(wire)
        } catch {
          /* swallow */
        }
      }
    })

    es.addEventListener('snapshot-end', (ev) => {
      if (!sid) return
      let payload: { highWater?: unknown } | null = null
      try {
        payload = JSON.parse((ev as MessageEvent).data) as { highWater?: unknown }
      } catch {
        return
      }
      const hw =
        typeof payload?.highWater === 'number' ? payload.highWater : this.highWater
      const set = this.snapshotEndHandlers.get(sid)
      if (!set) return
      for (const h of set) {
        try {
          h(hw)
        } catch {
          /* swallow */
        }
      }
    })

    es.addEventListener('table-change', (ev) => {
      let wire: LiveTableChangeFrame | null = null
      try {
        wire = JSON.parse((ev as MessageEvent).data) as LiveTableChangeFrame
      } catch {
        return
      }
      if (!wire || typeof wire.table !== 'string') return
      for (const h of this.tableChangeHandlers) {
        try {
          h(wire)
        } catch {
          /* swallow */
        }
      }
    })

    es.addEventListener('error', () => {
      // EventSource auto-reconnects on its own, but doing so would replay
      // the whole transcript every blip. Close and re-open from the
      // current high-water on a short delay instead.
      this.setError('live connection interrupted; retrying…')
      try {
        es.close()
      } catch {
        /* already closed */
      }
      if (this.es === es) this.es = null
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (!this.hasSubscribers()) return
        this.openConnection()
      }, 1000)
    })

    es.onopen = () => {
      this.setError(null)
    }
  }

  private close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.es) {
      try {
        this.es.close()
      } catch {
        /* already closed */
      }
      this.es = null
    }
  }

  private setError(msg: string | null): void {
    if (this.currentError === msg) return
    this.currentError = msg
    for (const h of this.errorHandlers) {
      try {
        h(msg)
      } catch {
        /* swallow */
      }
    }
  }
}

let _bus: LiveBus | null = null

export function liveBus(): LiveBus {
  if (!_bus) _bus = new LiveBus()
  return _bus
}
