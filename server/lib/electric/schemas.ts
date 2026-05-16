import { z } from 'zod'

/**
 * Wire-level schema for the `claude-code-cli` Electric Agents entity.
 *
 * This resolves "Pending discussion 1" in initial-design.md: the durable
 * `events` row shape (so the chat UI's UIMessage.parts projector is
 * stable), the `pendingDiffs` shape, and how `diff_decision` inbox
 * messages reference a parked IDE-bridge `openDiff` call by `callId`.
 *
 * `payload` uses `z.looseObject({})` deliberately: `z.record(...)` emits
 * JSON-Schema `propertyNames`, which agents-server's schema validator
 * rejects. `looseObject` emits a plain `{ type:"object",
 * additionalProperties:{} }` that's accepted and still captures
 * "any JSON object". (Confirmed against electric-source coding-session.ts.)
 */

export const creationArgsSchema = z.object({
  /** Domo's `sessions` row id (== entity id) — lets the in-process entity
   *  mirror live status/activity back into SQLite for the left rail. */
  sessionId: z.string(),
  envId: z.string(),
  coastInstance: z.string(),
  cwd: z.string(),
})
export type CreationArgs = z.infer<typeof creationArgsSchema>

export const promptInboxSchema = z.object({ text: z.string() })
export const diffDecisionInboxSchema = z.object({
  callId: z.string(),
  decision: z.enum(['accept', 'reject']),
})
export const abortInboxSchema = z.object({})

/**
 * idle    — waiting on next prompt (design's "waiting")
 * running — agent producing output (design's "active")
 * pending-approval — an openDiff is parked, needs the user
 * error   — last turn failed
 */
export const sessionStatusSchema = z.enum([
  'initializing',
  'idle',
  'running',
  'pending-approval',
  'error',
])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionMetaRowSchema = z.object({
  key: z.literal('current'),
  /** Domo `sessions` row id (== entity id); see creationArgsSchema. */
  sessionId: z.string(),
  envId: z.string(),
  coastInstance: z.string(),
  cwd: z.string(),
  status: sessionStatusSchema,
  /** Claude's own session id (from the first stream-json `system` event). */
  nativeSessionId: z.string().optional(),
  /** Port of the per-session IDE-bridge WS server, while a turn is live. */
  bridgePort: z.number().optional(),
  error: z.string().optional(),
  currentPromptInboxKey: z.string().optional(),
})
export type SessionMetaRow = z.infer<typeof sessionMetaRowSchema>

export const inboxStateRowSchema = z.object({
  key: z.literal('current'),
  lastProcessedInboxKey: z.string().optional(),
})
export type InboxStateRow = z.infer<typeof inboxStateRowSchema>

export const eventRowSchema = z.object({
  key: z.string(),
  ts: z.number(),
  /** stream-json envelope type or a Domo-synthesized type. */
  type: z.string(),
  /** Tool-use / openDiff correlation id, when applicable. */
  callId: z.string().optional(),
  payload: z.looseObject({}),
})
export type EventRow = z.infer<typeof eventRowSchema>

export const pendingDiffRowSchema = z.object({
  callId: z.string(),
  path: z.string(),
  before: z.string(),
  after: z.string(),
  tabName: z.string().optional(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  createdTs: z.number(),
})
export type PendingDiffRow = z.infer<typeof pendingDiffRowSchema>

/** Stable, content-derived, chronologically-sortable events key (dedupes replays). */
export function eventKey(ts: number, type: string, seed: string): string {
  const tsPart = String(ts).padStart(16, '0')
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0
  return `${tsPart}_${type}_${h.toString(16).padStart(8, '0')}`
}
