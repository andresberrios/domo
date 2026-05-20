/**
 * SQLite-backed event log + pending-diff queue for the in-process session
 * engine. This module IS the durable truth (Decided #6,#7): the old
 * Electric Agents durable stream is gone, `session_events` is the chat
 * transcript, append is atomic, no external store can desync from it.
 *
 * Schema (see `db.ts`): one row per envelope, monotonic `seq` per
 * `session_id` (the PK), `payload` as JSON. Streaming assistant deltas
 * (`--include-partial-messages` stream_events) are **NOT** stored — the
 * coalescer emits them live-only on the change bus / SSE, and the
 * complete `assistant` envelope (its own row here) is the source of
 * truth in the adapter. A reconnecting browser that missed an
 * in-flight partial simply renders nothing until the next flush (or
 * the final `assistant`) — partials are transient by design.
 *
 * SSE seq-tail (`/api/live?sessionId=&since=`) reads `readEvents(id,
 * sinceSeq)` for reconnect / late join. Every row is an INSERT (no
 * UPDATEs), so seq is monotonic and the cursor is naturally idempotent.
 */
import { db } from '../db'

export type SessionEventType =
  | 'system'
  | 'assistant'
  | 'user'
  | 'result'
  | 'prompt'
  | 'steer_sent'
  | 'pending_diff'
  | 'diff_decision'
  | 'aborted'
  | 'error'
  // Anything the CLI emits we don't model explicitly (e.g. `rate_limit_event`)
  // is recorded by its envelope type as a free-form string. The adapter
  // ignores unknown types — they're durable for debugging, invisible to the UI.
  | (string & Record<never, never>)

export interface SessionEventRow {
  sessionId: string
  seq: number
  type: SessionEventType
  payload: Record<string, unknown>
  createdAt: number
}

interface SessionEventDbRow {
  session_id: string
  seq: number
  type: string
  payload: string
  created_at: number
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  return {}
}

function fromDb(r: SessionEventDbRow): SessionEventRow {
  return {
    sessionId: r.session_id,
    seq: r.seq,
    type: r.type,
    payload: parsePayload(r.payload),
    createdAt: r.created_at,
  }
}

/**
 * Append one event. Returns the assigned monotonic `seq`. `INSERT … VALUES
 * (..., (SELECT … +1), …)` is atomic under SQLite's WAL + the singleton
 * better-sqlite3 handle, so concurrent appends from the in-process engine
 * (single-flight per session anyway) and the SSE consumer don't race.
 */
export function appendEvent(args: {
  sessionId: string
  type: SessionEventType
  payload: Record<string, unknown>
  createdAt?: number
}): SessionEventRow {
  const createdAt = args.createdAt ?? Date.now()
  const payload = JSON.stringify(args.payload)
  const seq = db()
    .prepare(
      `
      INSERT INTO session_events (
        session_id, seq, type, payload, created_at
      ) VALUES (
        @sessionId,
        COALESCE(
          (SELECT MAX(seq) + 1 FROM session_events WHERE session_id = @sessionId),
          1
        ),
        @type, @payload, @createdAt
      )
      RETURNING seq
      `,
    )
    .get({
      sessionId: args.sessionId,
      type: args.type,
      payload,
      createdAt,
    }) as { seq: number }
  return {
    sessionId: args.sessionId,
    seq: seq.seq,
    type: args.type,
    payload: args.payload,
    createdAt,
  }
}

export function readEvents(sessionId: string, sinceSeq = 0): SessionEventRow[] {
  const rows = db()
    .prepare(
      `
      SELECT * FROM session_events
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      `,
    )
    .all(sessionId, sinceSeq) as SessionEventDbRow[]
  return rows.map(fromDb)
}

export function lastSeq(sessionId: string): number {
  const r = db()
    .prepare(`SELECT MAX(seq) AS seq FROM session_events WHERE session_id = ?`)
    .get(sessionId) as { seq: number | null } | undefined
  return r?.seq ?? 0
}

// ─── pending_diffs ────────────────────────────────────────────────────────

export interface PendingDiffRow {
  sessionId: string
  callId: string
  path: string
  before: string
  after: string
  tabName: string | null
  status: 'pending' | 'accepted' | 'rejected'
  createdTs: number
}

interface PendingDiffDbRow {
  session_id: string
  call_id: string
  path: string
  before: string
  after: string
  tab_name: string | null
  status: string
  created_ts: number
}

function pdFromDb(r: PendingDiffDbRow): PendingDiffRow {
  return {
    sessionId: r.session_id,
    callId: r.call_id,
    path: r.path,
    before: r.before,
    after: r.after,
    tabName: r.tab_name,
    status: r.status as PendingDiffRow['status'],
    createdTs: r.created_ts,
  }
}

export function insertPendingDiff(row: PendingDiffRow): void {
  db()
    .prepare(
      `
      INSERT INTO pending_diffs (
        session_id, call_id, path, before, after, tab_name, status, created_ts
      ) VALUES (
        @sessionId, @callId, @path, @before, @after, @tabName, @status, @createdTs
      )
      `,
    )
    .run(row)
}

export function setPendingDiffStatus(
  sessionId: string,
  callId: string,
  status: PendingDiffRow['status'],
): void {
  db()
    .prepare(
      `UPDATE pending_diffs SET status = ? WHERE session_id = ? AND call_id = ?`,
    )
    .run(status, sessionId, callId)
}

export function getPendingDiff(
  sessionId: string,
  callId: string,
): PendingDiffRow | null {
  const r = db()
    .prepare(
      `SELECT * FROM pending_diffs WHERE session_id = ? AND call_id = ?`,
    )
    .get(sessionId, callId) as PendingDiffDbRow | undefined
  return r ? pdFromDb(r) : null
}

export function listPendingDiffs(sessionId: string): PendingDiffRow[] {
  const rows = db()
    .prepare(
      `SELECT * FROM pending_diffs WHERE session_id = ? ORDER BY created_ts ASC`,
    )
    .all(sessionId) as PendingDiffDbRow[]
  return rows.map(pdFromDb)
}

/**
 * Boot-reconcile orphans: any `pending` diff seen at process start belongs
 * to a turn that died (the parking handler is gone). Mark them rejected so
 * the chat card clears; the next prompt resumes via `--resume` and may
 * re-propose a fresh, actionable diff.
 */
export function rejectAllPending(sessionId: string): PendingDiffRow[] {
  const stale = db()
    .prepare(
      `SELECT * FROM pending_diffs WHERE session_id = ? AND status = 'pending'`,
    )
    .all(sessionId) as PendingDiffDbRow[]
  if (stale.length === 0) return []
  db()
    .prepare(
      `UPDATE pending_diffs SET status = 'rejected' WHERE session_id = ? AND status = 'pending'`,
    )
    .run(sessionId)
  return stale.map(pdFromDb)
}
