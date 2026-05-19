/**
 * Shared Zod schemas for procedure inputs/outputs.
 *
 * Keeping a single home for these means the TS types feed both the
 * `defineProcedure` boundaries on the server and the `apiClient`-derived
 * client types in the UI. Add schemas here when a shape is referenced by
 * more than one procedure; per-procedure shapes can stay inline.
 */
import { z } from 'zod'

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  defaultBranch: z.string().nullable(),
  hasCoastfile: z.boolean(),
  createdAt: z.number().int(),
})
export type Project = z.infer<typeof Project>

export const Env = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  coastInstanceName: z.string(),
  /** Cached status from coastd `/ls`; nullable for newly-created envs. */
  status: z.string().nullable(),
  /** Live values folded in from a fresh `/ls` lookup when present. */
  liveStatus: z.string().nullable().optional(),
  checkedOut: z.boolean().optional(),
  createdAt: z.number().int(),
})
export type Env = z.infer<typeof Env>

/**
 * UX-shaped session metadata mirrored in Domo's SQLite. The full event log
 * lives in the Electric Agents durable stream (`durableStreamUrl`); this row
 * just points at it and owns Domo concepts (title override, `done` flag,
 * per-device viewed-at) plus a cached status for fast first render. Status
 * is reconciled against the stream's `sessionMeta` client-side (Phase 9/10).
 */
export const SessionStatus = z.enum([
  'waiting',
  'active',
  'pending-approval',
  'error',
])
export type SessionStatus = z.infer<typeof SessionStatus>

/**
 * Per-session edit-approval policy (Decided #22). Resolved at turn start
 * as `session.approvalMode ?? config.claude.approvalMode ?? 'manual'`.
 *
 * - `manual`      — every file edit parks as a diff-approval card the user
 *                   must accept/reject (the original Phase-3 behavior).
 *                   The only mode that *parks*, so the only one exposed to
 *                   the restart-resume fragility.
 * - `auto`        — Domo auto-approves all tools incl. edits; no park.
 *                   (`claude` spawned `--permission-mode acceptEdits`.)
 * - `passthrough` — Domo does not force `--permission-mode`; the user's
 *                   own `~/.claude/settings.json` (e.g. `defaultMode:
 *                   "auto"` + its model classifier) decides. No Domo park.
 */
export const ApprovalMode = z.enum(['manual', 'auto', 'passthrough'])
export type ApprovalMode = z.infer<typeof ApprovalMode>

export const Session = z.object({
  id: z.string(),
  envId: z.string(),
  title: z.string().nullable(),
  status: SessionStatus,
  done: z.boolean(),
  /** Electric Agents entity url, e.g. `/claude-code-cli/<id>`. */
  entityId: z.string().nullable(),
  /** Absolute URL the chat surface subscribes to (Phase 9). */
  durableStreamUrl: z.string().nullable(),
  nativeClaudeSessionId: z.string().nullable(),
  /** Per-session edit-approval policy; null → inherit the config default. */
  approvalMode: ApprovalMode.nullable(),
  createdAt: z.number().int(),
  lastEventAt: z.number().int().nullable(),
  /** deviceId → epoch ms last viewed (drives the new-output dot, Phase 10). */
  viewedAtPerDevice: z.record(z.string(), z.number()),
})
export type Session = z.infer<typeof Session>

/**
 * Public projection of a `users` row — never carries the password hash.
 * `role`/`status` are authoritative from the DB (the session cookie holds
 * identity only); the client uses these for routing (pending → waiting
 * screen, admin → user-management UI).
 */
export const UserRole = z.enum(['admin', 'member'])
export type UserRole = z.infer<typeof UserRole>

export const UserStatus = z.enum(['active', 'pending'])
export type UserStatus = z.infer<typeof UserStatus>

export const PublicUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: UserRole,
  status: UserStatus,
  createdAt: z.number().int(),
  lastLoginAt: z.number().int().nullable(),
})
export type PublicUser = z.infer<typeof PublicUser>

export const FsEntry = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
  hidden: z.boolean(),
})
export type FsEntry = z.infer<typeof FsEntry>
