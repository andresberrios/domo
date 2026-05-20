/**
 * `/api/live` — the unified reactivity SSE (Decided #8). One auth-gated
 * stream per browser, **singleton client** (`useLiveBus` opens at most
 * one connection per tab and refocuses it as the user navigates between
 * sessions).
 *
 * Three SSE event types share one connection:
 *
 *   - `session-event` — every durable `session_events` row past `?since=`,
 *     replayed once at connect (the lossless snapshot) and then streamed
 *     live as the engine appends. `seq` is the cursor. Only emitted when
 *     `?sessionId=` is set.
 *
 *   - `partial` — **live-only** streaming assistant deltas (coalesced
 *     from `--include-partial-messages`, throttled ~10 Hz). NOT replayed
 *     on connect — partials are transient by design; the complete
 *     `assistant` envelope arrives on the durable channel and supersedes
 *     them in the adapter. A reconnecting browser that missed an
 *     in-flight delta renders nothing until the next flush. Only
 *     emitted when `?sessionId=` is set.
 *
 *   - `table-change` — coarse `{table,id,op}` notices fired by helper-
 *     layer writes in `lib/{sessions,envs,projects}.ts`. Always on,
 *     regardless of `?sessionId=`; the browser composable
 *     `useLiveRefresh` drives a per-`useCall` `refresh()` whenever a
 *     matching notice lands. No replay — `useCall` data is the
 *     snapshot, a refetch is the catch-up. A missed notice (network
 *     blip) self-heals on the next legitimate change.
 *
 * `?sessionId=` is optional. Without it, the connection only carries
 * `table-change` (used on pages that don't show a chat — env overview,
 * project list, the landing screen). With it, all three event types
 * are delivered on the same connection.
 */
import { changeBus } from '../lib/changeBus'
import { readEvents } from '../lib/sessionEngine/store'
import { getSession } from '../lib/sessions'

interface WireEvent {
  seq: number
  type: string
  payload: Record<string, unknown>
  createdAt: number
}

interface WirePartial {
  messageId: string
  text: string
  thinking: string
  createdAt: number
}

interface WireTableChange {
  table: string
  id: string
  op: string
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const rawSessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  const sessionId = rawSessionId.length > 0 ? rawSessionId : null
  if (sessionId) {
    const session = getSession(sessionId)
    if (!session) {
      throw createError({ statusCode: 404, statusMessage: 'session not found' })
    }
  }
  const since = Number.parseInt(
    typeof query.since === 'string' ? query.since : '0',
    10,
  )
  const sinceSeq = Number.isFinite(since) && since >= 0 ? since : 0

  const res = event.node.res
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  // Disable nginx-style proxy buffering so chunks reach the browser promptly.
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let closed = false
  let highWater = sinceSeq

  function writeFrame(eventName: string, payload: unknown): void {
    if (closed) return
    try {
      res.write(`event: ${eventName}\n`)
      res.write(`data: ${JSON.stringify(payload)}\n\n`)
    } catch {
      closed = true
    }
  }

  function emitRow(seq: number, wire: WireEvent): void {
    if (!sessionId) return
    writeFrame('session-event', { sessionId, ...wire })
    if (seq > highWater) highWater = seq
  }

  const unsubs: Array<() => void> = []

  if (sessionId) {
    // ── Initial snapshot: every durable row past `since`. Captures the
    //    fresh-tab case (since=0 → full transcript) and the reconnect-
    //    with-since case (lossless). Partials are NOT replayed.
    for (const row of readEvents(sessionId, sinceSeq)) {
      emitRow(row.seq, {
        seq: row.seq,
        type: row.type,
        payload: row.payload,
        createdAt: row.createdAt,
      })
    }
    writeFrame('snapshot-end', { highWater })

    const focusedSessionId = sessionId

    // ── Live subscribe: durable events past the high-water mark,
    //    batched on each notice so a flurry catches up in one read.
    unsubs.push(
      changeBus().subscribeSessionEvents(focusedSessionId, (n) => {
        if (closed) return
        if (n.seq <= highWater) return // already sent (defensive — shouldn't happen)
        for (const row of readEvents(focusedSessionId, highWater)) {
          emitRow(row.seq, {
            seq: row.seq,
            type: row.type,
            payload: row.payload,
            createdAt: row.createdAt,
          })
        }
      }),
    )

    // ── Live subscribe: streaming partial frames (live-only, no replay).
    unsubs.push(
      changeBus().subscribeSessionPartials(focusedSessionId, (frame) => {
        if (closed) return
        const wire: WirePartial = {
          messageId: frame.messageId,
          text: frame.text,
          thinking: frame.thinking,
          createdAt: frame.createdAt,
        }
        writeFrame('partial', { sessionId: focusedSessionId, ...wire })
      }),
    )
  }

  // ── Live subscribe: coarse table-change notices (always on). A
  //    missed notice self-heals on the next change — there is no
  //    replay because `useCall` already has its own snapshot.
  unsubs.push(
    changeBus().subscribeTableChanges((notice) => {
      if (closed) return
      const wire: WireTableChange = {
        table: notice.table,
        id: notice.id,
        op: notice.op,
      }
      writeFrame('table-change', wire)
    }),
  )

  // ── Keep-alive (15 s, well under typical proxy idle-close): a comment
  //    frame keeps the connection warm without polluting `eventsource`'s
  //    onmessage.
  const keepalive = setInterval(() => {
    if (closed) return
    try {
      res.write(': keepalive\n\n')
    } catch {
      closed = true
    }
  }, 15000)

  event.node.req.on('close', () => {
    if (closed) return
    closed = true
    clearInterval(keepalive)
    for (const unsub of unsubs) {
      try {
        unsub()
      } catch {
        /* already gone */
      }
    }
    try {
      res.end()
    } catch {
      /* already ended */
    }
  })

  // Hold the response open — Nitro otherwise considers the handler
  // resolved and ends the stream. The Promise resolves on close (above).
  return new Promise<void>((resolve) => {
    event.node.req.on('close', () => resolve())
  })
})
