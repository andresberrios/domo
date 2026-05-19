/**
 * Client-side mirrors of the in-process session engine's wire shapes.
 *
 * The authoritative server types live in `server/lib/sessionEngine/store.ts`
 * (`SessionEventRow`, `PendingDiffRow`) and `server/lib/schemas.ts`
 * (`SessionStatus`), but `server/` is not bundled to the client — these
 * structural copies stay in sync by convention (they're tiny and rarely
 * change).
 */

/** One row from `/api/live`'s `session-event` frame (and the snapshot replay). */
export interface EventRow {
  /** Monotonic per-session insertion id; primary key on the wire. */
  seq: number
  /** stream-json envelope type or a Domo-synthesized type (see store.ts). */
  type: string
  /** The raw stream-json envelope OR the Domo-synthesized payload. */
  payload: Record<string, unknown>
  createdAt: number
}

/**
 * One frame from `/api/live`'s `partial` event — the latest coalesced
 * streaming assistant delta. Live-only (not replayed on reconnect);
 * superseded by the complete `assistant` event row matched on `messageId`.
 */
export interface PartialFrame {
  /** Anthropic `message.id` — the bubble id joined against the final `assistant`. */
  messageId: string
  text: string
  thinking: string
  createdAt: number
}

/** Derived client-side by folding `pending_diff` ⊕ `diff_decision` events. */
export interface PendingDiffRow {
  callId: string
  path: string
  before: string
  after: string
  tabName: string
  status: 'pending' | 'accepted' | 'rejected'
  createdTs: number
}

export type ChatSessionStatus =
  | 'waiting'
  | 'active'
  | 'pending-approval'
  | 'error'
