/**
 * Session helpers — typed CRUD against the `sessions` table.
 *
 * A session row is Domo's UX-shaped pointer at an Electric Agents
 * `claude-code-cli` entity: it stores the entity url + durable-stream URL
 * (so the chat surface can subscribe) plus Domo-owned concepts the durable
 * stream does not model — the editable `title`, the `done` flag, and
 * per-device `viewed_at` for the new-output dot. `status` is a cache for
 * fast first render; the authoritative value is the entity's `sessionMeta`
 * row, reconciled client-side in Phase 9/10.
 */
import { db } from './db'
import type { SessionStatus } from './schemas'

export interface SessionRow {
  id: string
  envId: string
  title: string | null
  status: SessionStatus
  done: boolean
  entityId: string | null
  durableStreamUrl: string | null
  nativeClaudeSessionId: string | null
  createdAt: number
  lastEventAt: number | null
  viewedAtPerDevice: Record<string, number>
}

interface SessionDbRow {
  id: string
  env_id: string
  title: string | null
  status: string
  done: number
  entity_id: string | null
  durable_stream_url: string | null
  native_claude_session_id: string | null
  created_at: number
  last_event_at: number | null
  viewed_at_per_device: string
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
    entityId: r.entity_id,
    durableStreamUrl: r.durable_stream_url,
    nativeClaudeSessionId: r.native_claude_session_id,
    createdAt: r.created_at,
    lastEventAt: r.last_event_at,
    viewedAtPerDevice: parseViewed(r.viewed_at_per_device),
  }
}

export function listSessions(envId: string): SessionRow[] {
  const rows = db()
    .prepare(`SELECT * FROM sessions WHERE env_id = ? ORDER BY created_at ASC`)
    .all(envId) as SessionDbRow[]
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
        id, env_id, title, status, done, entity_id, durable_stream_url,
        native_claude_session_id, created_at, last_event_at,
        viewed_at_per_device
      ) VALUES (
        @id, @envId, @title, @status, @done, @entityId, @durableStreamUrl,
        @nativeClaudeSessionId, @createdAt, @lastEventAt, @viewedAtPerDevice
      )
    `,
    )
    .run({
      ...row,
      done: row.done ? 1 : 0,
      viewedAtPerDevice: JSON.stringify(row.viewedAtPerDevice),
    })
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
      | 'lastEventAt'
      | 'viewedAtPerDevice'
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
  if (fields.lastEventAt !== undefined) {
    sets.push('last_event_at = @lastEventAt')
    params.lastEventAt = fields.lastEventAt
  }
  if (fields.viewedAtPerDevice !== undefined) {
    sets.push('viewed_at_per_device = @viewedAtPerDevice')
    params.viewedAtPerDevice = JSON.stringify(fields.viewedAtPerDevice)
  }
  if (sets.length === 0) return
  db()
    .prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`)
    .run(params)
}

export function deleteSession(id: string): void {
  db().prepare(`DELETE FROM sessions WHERE id = ?`).run(id)
}
