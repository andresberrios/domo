/**
 * Session helpers — typed CRUD against the `sessions` table.
 *
 * The row is Domo's UX-shaped pointer at the in-process engine: title,
 * `done`, per-device `viewed_at`, cached `status`, and `nativeClaudeSessionId`
 * (Claude's own session id captured from the first `system` event, used as
 * `--resume <id>` on subsequent turns / after a process restart).
 *
 * The old `entityId` / `durableStreamUrl` (pre-pivot Electric Agents
 * pointers) are unused: the DB columns linger as harmless NULLs (SQLite
 * column drops are awkward; nothing reads them), but they're absent from
 * the TS row and the procedure schema. The chat surface subscribes via the
 * new `/api/live` SSE keyed by the Domo session id.
 */
import { changeBus } from './changeBus'
import { db } from './db'
import type { ApprovalMode, SessionStatus } from './schemas'

export interface SessionRow {
  id: string
  envId: string
  title: string | null
  status: SessionStatus
  done: boolean
  /** Claude's own session id (captured on first `system` event) → `--resume`. */
  nativeClaudeSessionId: string | null
  /** null → inherit `config.claude.approvalMode` (default `manual`). */
  approvalMode: ApprovalMode | null
  createdAt: number
  lastEventAt: number | null
  viewedAtPerDevice: Record<string, number>
  /** Highest `chat`-event seq the engine has folded into a triggered
   * turn's synthesized prompt (step 5 group-chat collab). 0 = none
   * consumed yet. */
  lastChatConsumedSeq: number
}

interface SessionDbRow {
  id: string
  env_id: string
  title: string | null
  status: string
  done: number
  native_claude_session_id: string | null
  approval_mode: string | null
  created_at: number
  last_event_at: number | null
  viewed_at_per_device: string
  last_chat_consumed_seq: number
}

function parseViewed(json: string): Record<string, number> {
  try {
    const v = JSON.parse(json) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, number>
    }
  } catch {
    /* corrupt JSON — fall back to empty */
  }
  return {}
}

function fromDb(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    envId: r.env_id,
    title: r.title,
    status: r.status as SessionStatus,
    done: r.done === 1,
    nativeClaudeSessionId: r.native_claude_session_id,
    approvalMode: (r.approval_mode as ApprovalMode | null) ?? null,
    createdAt: r.created_at,
    lastEventAt: r.last_event_at,
    viewedAtPerDevice: parseViewed(r.viewed_at_per_device),
    lastChatConsumedSeq: r.last_chat_consumed_seq ?? 0,
  }
}

export function listSessions(envId: string): SessionRow[] {
  const rows = db()
    .prepare(`SELECT * FROM sessions WHERE env_id = ? ORDER BY created_at ASC`)
    .all(envId) as SessionDbRow[]
  return rows.map(fromDb)
}

export function listAllSessions(): SessionRow[] {
  const rows = db()
    .prepare(`SELECT * FROM sessions ORDER BY created_at ASC`)
    .all() as SessionDbRow[]
  return rows.map(fromDb)
}

export function getSession(id: string): SessionRow | null {
  const r = db().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as
    | SessionDbRow
    | undefined
  return r ? fromDb(r) : null
}

export function insertSession(row: SessionRow): void {
  db()
    .prepare(
      `
      INSERT INTO sessions (
        id, env_id, title, status, done,
        native_claude_session_id, approval_mode, created_at, last_event_at,
        viewed_at_per_device
      ) VALUES (
        @id, @envId, @title, @status, @done,
        @nativeClaudeSessionId, @approvalMode, @createdAt, @lastEventAt,
        @viewedAtPerDevice
      )
    `,
    )
    .run({
      ...row,
      done: row.done ? 1 : 0,
      approvalMode: row.approvalMode ?? null,
      viewedAtPerDevice: JSON.stringify(row.viewedAtPerDevice),
    })
  changeBus().emitTableChange({ table: 'sessions', id: row.id, op: 'insert' })
}

export function updateSession(
  id: string,
  fields: Partial<
    Pick<
      SessionRow,
      | 'title'
      | 'status'
      | 'done'
      | 'nativeClaudeSessionId'
      | 'approvalMode'
      | 'lastEventAt'
      | 'viewedAtPerDevice'
      | 'lastChatConsumedSeq'
    >
  >,
): void {
  const sets: string[] = []
  const params: Record<string, unknown> = { id }
  if (fields.title !== undefined) {
    sets.push('title = @title')
    params.title = fields.title
  }
  if (fields.status !== undefined) {
    sets.push('status = @status')
    params.status = fields.status
  }
  if (fields.done !== undefined) {
    sets.push('done = @done')
    params.done = fields.done ? 1 : 0
  }
  if (fields.nativeClaudeSessionId !== undefined) {
    sets.push('native_claude_session_id = @nativeClaudeSessionId')
    params.nativeClaudeSessionId = fields.nativeClaudeSessionId
  }
  if (fields.approvalMode !== undefined) {
    sets.push('approval_mode = @approvalMode')
    params.approvalMode = fields.approvalMode
  }
  if (fields.lastEventAt !== undefined) {
    sets.push('last_event_at = @lastEventAt')
    params.lastEventAt = fields.lastEventAt
  }
  if (fields.viewedAtPerDevice !== undefined) {
    sets.push('viewed_at_per_device = @viewedAtPerDevice')
    params.viewedAtPerDevice = JSON.stringify(fields.viewedAtPerDevice)
  }
  if (fields.lastChatConsumedSeq !== undefined) {
    sets.push('last_chat_consumed_seq = @lastChatConsumedSeq')
    params.lastChatConsumedSeq = fields.lastChatConsumedSeq
  }
  if (sets.length === 0) return
  db()
    .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
  changeBus().emitTableChange({ table: 'sessions', id, op: 'update' })
}

/**
 * Stamp one device's last-viewed time (read-modify-write the JSON map so
 * parallel devices don't clobber each other's entries). Drives the
 * left-rail new-output dot: a session shows the dot when its
 * `lastEventAt` is newer than this device's stamp. No-op if the row is
 * gone. Returns the updated row (null if missing).
 */
export function markSessionViewed(
  id: string,
  deviceId: string,
  ts: number,
): SessionRow | null {
  const session = getSession(id)
  if (!session) return null
  const viewedAtPerDevice = { ...session.viewedAtPerDevice, [deviceId]: ts }
  updateSession(id, { viewedAtPerDevice })
  return { ...session, viewedAtPerDevice }
}

export function deleteSession(id: string): void {
  db().prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
  changeBus().emitTableChange({ table: 'sessions', id, op: 'delete' })
}
