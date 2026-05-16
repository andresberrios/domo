/**
 * Client-side mirrors of the `claude-code-cli` entity's durable row shapes.
 *
 * The authoritative Zod schemas live in `server/lib/electric/schemas.ts`,
 * but `server/` is server-only and not bundled to the client, so the chat
 * surface keeps its own structural copies. Keep these in sync with that
 * file (they're tiny and change rarely; the entity's row schemas are
 * "locked" per design Pending-Discussion 1).
 */

/** A mirrored claude stream-json envelope (payload) + Domo metadata. */
export interface EventRow {
  key: string
  ts: number
  /** stream-json envelope type (`system`/`assistant`/`user`/`result`/…). */
  type: string
  callId?: string
  /** The raw claude stream-json envelope. */
  payload: Record<string, unknown>
}

export interface SessionMetaRow {
  key: 'current'
  envId: string
  coastInstance: string
  cwd: string
  status: 'initializing' | 'idle' | 'running' | 'pending-approval' | 'error'
  nativeSessionId?: string
  bridgePort?: number
  error?: string
  currentPromptInboxKey?: string
}

export interface PendingDiffRow {
  callId: string
  path: string
  before: string
  after: string
  tabName?: string
  status: 'pending' | 'accepted' | 'rejected'
  createdTs: number
}

/** Built-in `inbox` collection row (agents-runtime `MessageReceived`). */
export interface InboxRow {
  key: string
  from: string
  payload?: unknown
  timestamp: string
  message_type?: string
}
