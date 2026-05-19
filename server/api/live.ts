/**
 * `/api/live` — the unified reactivity SSE (Decided #8). One auth-gated
 * stream per browser, **singleton client** (the chat surface composable
 * reuses the connection across session navigations).
 *
 * Step 1 implements the **chat fine path** on two SSE event types:
 *
 *   - `session-event` — every durable `session_events` row past `?since=`,
 *     replayed once at connect (the lossless snapshot) and then live as
 *     the engine appends. `seq` is the cursor.
 *
 *   - `partial` — **live-only** streaming assistant deltas (coalesced
 *     from `--include-partial-messages`, throttled ~10 Hz). NOT replayed
 *     on connect — partials are transient by design; the complete
 *     `assistant` envelope arrives on the durable channel and supersedes
 *     them in the adapter. A reconnecting browser that missed an
 *     in-flight delta renders nothing until the next flush.
 *
 * Step 2 adds the coarse table path (`{table,id,op}` → procedure refetch)
 * to this same endpoint and the singleton client wrapper.
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

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const sessionId = typeof query.sessionId === 'string' ? query.sessionId : ''
  if (!sessionId) {
    throw createError({ statusCode: 400, statusMessage: 'sessionId required' })
  }
  const session = getSession(sessionId)
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: 'session not found' })
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
    writeFrame('session-event', { sessionId, ...wire })
    if (seq > highWater) highWater = seq
  }

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

  // ── Live subscribe: durable events past the high-water mark, batched
  //    on each notice so a flurry catches up in one read.
  const unsubEvents = changeBus().subscribeSessionEvents(sessionId, (n) => {
    if (closed) return
    if (n.seq <= highWater) return // already sent (defensive — shouldn't happen)
    for (const row of readEvents(sessionId, highWater)) {
      emitRow(row.seq, {
        seq: row.seq,
        type: row.type,
        payload: row.payload,
        createdAt: row.createdAt,
      })
    }
  })

  // ── Live subscribe: streaming partial frames (live-only, no replay).
  const unsubPartials = changeBus().subscribeSessionPartials(
    sessionId,
    (frame) => {
      if (closed) return
      const wire: WirePartial = {
        messageId: frame.messageId,
        text: frame.text,
        thinking: frame.thinking,
        createdAt: frame.createdAt,
      }
      writeFrame('partial', { sessionId, ...wire })
    },
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
    try {
      unsubEvents()
    } catch {
      /* already gone */
    }
    try {
      unsubPartials()
    } catch {
      /* already gone */
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
