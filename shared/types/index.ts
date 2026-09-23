/**
 * Domain types shared between the Nitro server and the Nuxt app.
 */

export type VoiceSessionStatus = 'idle' | 'live' | 'error'

/** Who set a conversation's title: auto-titling only ever replaces its own. */
export type VoiceTitleSource = 'auto' | 'user'

export interface VoiceSession {
  id: string
  title: string
  titleSource: VoiceTitleSource
  status: VoiceSessionStatus
  model: string
  voice: string
  createdAt: string
  updatedAt: string
  lastActivityAt: string | null
  archived: boolean
  /**
   * Rolling summary of everything up to `summaryThroughSeq`, folded in as the
   * conversation grows so a reconnect never has to replay the whole log.
   */
  summary: string | null
  /** The last `voice_messages.seq` the summary covers; null before the first fold. */
  summaryThroughSeq: number | null
  summaryUpdatedAt: string | null
  /** How much of the Live model's context this conversation is using. */
  usage: VoiceUsage | null
}

export type VoiceMessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface VoiceMessage {
  id: string
  sessionId: string
  seq: number
  role: VoiceMessageRole
  text: string
  /** Set for role === 'tool': the function name that was called. */
  toolName: string | null
  meta: Record<string, unknown> | null
  createdAt: string
}

export type AgentSessionStatus =
  | 'idle'
  | 'starting'
  | 'thinking'
  | 'awaiting-permission'
  | 'error'
  | 'stopped'

export type AgentAdapter = 'claude-code' | 'codex' | 'opencode'

/**
 * What OpenCode does when a tool reaches outside the session's working
 * directory. `deny` exists in OpenCode's own schema and is deliberately not
 * offered: it is not a setting worth a picker, and it broke the provider
 * outright when probed.
 */
export type OpenCodePermission = 'ask' | 'allow'

export interface AgentSession {
  id: string
  voiceSessionId: string | null
  adapter: AgentAdapter
  acpSessionId: string | null
  title: string
  cwd: string
  devEnvironmentId: string | null
  status: AgentSessionStatus
  modeId: string | null
  modes: SessionModeInfo[] | null
  /** The model this session runs on, as the adapter reports it. Null is "the adapter's default". */
  model: string | null
  /**
   * What was *asked for* on this session's adapter-specific settings, by id.
   * Re-applied on every attach, because `session/load` restores the adapter's
   * own defaults and not Domo's choices.
   */
  config: Record<string, string> | null
  /** The selects the adapter last reported, minus mode and model. */
  configOptions: SessionConfigOptionInfo[] | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  lastActivityAt: string | null
  /**
   * Whether it shows up in a list. The only visibility state a session has.
   *
   * Deliberately says nothing about whether the session can *run*: that is
   * derived from the place it ran (`sessionStartability` in
   * `shared/retention.ts`) and is never stored. Retiring an environment makes
   * every session in it unstartable and archives none of them.
   */
  archived: boolean
  /** Rolling summary of the agent's most recent output, for the voice agent. */
  summary: string | null
  /** Context-window occupancy and session cost, as the adapter last reported them. */
  usage: AgentUsage | null
}

/* ------------------------------------------------------------------ */
/* usage                                                               */
/* ------------------------------------------------------------------ */

/**
 * How full a session's context window is, and what the session has cost.
 *
 * This is session *state*, not transcript: it is a column on the session row
 * rewritten in place, never an `agent_events` entry. The ACP `usage_update`
 * that carries it arrives many times a turn and says nothing about what the
 * agent did — a row per reading would be noise with a `seq` in the middle of
 * the text it interrupted.
 */
export interface AgentUsage {
  context: { used: number, size: number }
  /** The session's cumulative cost, when the adapter reports one (Claude only). */
  cost?: { amount: number, currency: string }
  updatedAt: string
}

/**
 * How full a voice conversation's context window is.
 *
 * `size` is null for a Live model Domo has no window size for — the API never
 * reports one — and `used` may *decrease*: sliding-window compression drops old
 * turns, and a fresh session after a fingerprint mismatch starts again at zero.
 */
export interface VoiceUsage {
  context: { used: number, size: number | null }
  updatedAt: string
}

/** Which account a limit belongs to. */
export type UsageProviderId = 'claude' | 'codex' | 'opencode'

/**
 * Where a limit reading came from, best first.
 *
 * `endpoint` is Claude's own `/api/oauth/usage`, `headers` the unified
 * rate-limit headers on a probe response, `app-server` Codex's
 * `account/rateLimits/read`, and `session-event` a reading that rode in on a
 * coding agent's `usage_update` while it worked. The first three are polls and
 * describe every window; a session event is current but sparse, so it refreshes
 * the windows it names and never removes the ones it does not.
 */
export type UsageLimitSource = 'endpoint' | 'headers' | 'session-event' | 'app-server'

/** Whether the window still lets a request through. */
export type UsageLimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

/**
 * One rate-limit window of one provider's plan.
 *
 * Account-wide rather than per session: the limits are the developer's, not any
 * one agent's, and they have to be readable when nothing is running at all.
 */
export interface UsageLimit {
  provider: UsageProviderId
  /** `five_hour`, `seven_day`, `extra_usage`, or for Codex `<limitId>:primary`. */
  limitId: string
  label: string
  /** 0-100, whatever scale the source reported in. */
  usedPercent: number | null
  /** ISO 8601, whatever the source reported in. */
  resetsAt: string | null
  windowMinutes: number | null
  status: UsageLimitStatus | null
  /** Credits spent and the cap on them, for a row that is money rather than a percentage. */
  amountUsed: number | null
  amountLimit: number | null
  currency: string | null
  source: UsageLimitSource
  updatedAt: string
}

/** Whether a provider's poll is working, so the UI can tell three states apart. */
export type UsageProviderState = 'ok' | 'unconfigured' | 'error'

/**
 * The health of one provider's poll.
 *
 * Separate from the limits themselves so a failing poll leaves the last good
 * readings in place — they carry their own `updatedAt`, so the UI can say "as
 * of 12 minutes ago" rather than showing nothing or, worse, a fabricated 0%.
 */
export interface UsageProvider {
  provider: UsageProviderId
  state: UsageProviderState
  /** Why, in a sentence a person can act on. Never carries a token. */
  message: string | null
  checkedAt: string
}

export interface Project {
  id: string
  name: string
  repoPath: string
  createdAt: string
  updatedAt: string
  /**
   * When it was retired: its environments' containers and checkouts were
   * destroyed and every row was kept. Never restorable, and never hidden from
   * a session that needs to say where it ran.
   */
  retiredAt: string | null
}

export type DevEnvironmentStatus = 'creating' | 'running' | 'stopped' | 'error'
export type DevEnvironmentConfigSource = 'domo' | 'default'

export interface DevEnvironment {
  id: string
  projectId: string
  name: string
  containerName: string
  containerId: string | null
  workspacePath: string
  configSource: DevEnvironmentConfigSource
  configPath: string | null
  remoteUser: string | null
  status: DevEnvironmentStatus
  lastError: string | null
  createdAt: string
  updatedAt: string
  /**
   * When the container, its workspace volume and its image were destroyed.
   *
   * The row outlives them, which is the whole point: it is the only record of
   * where the sessions that ran here ran, and it is what makes every one of
   * them unstartable. Never restorable.
   */
  retiredAt: string | null
}

/**
 * What to do with whatever was uncommitted on the host when an environment is
 * created. `discard` (the default) starts the environment from the project's
 * HEAD; `carry` brings the host's working tree over and records it as a commit,
 * so the environment's git still agrees with its files.
 */
export type WorkingTreeMode = 'discard' | 'carry'

/** What the host's working tree looked like when an environment was seeded, and what was done with it. */
export interface WorkspaceSeedReport {
  mode: WorkingTreeMode
  /** Paths git called dirty on the host, capped; `total` is how many there really were. */
  paths: string[]
  total: number
  /** The commit the carried changes were recorded as, when anything was carried. */
  commit: string | null
}

export interface DevEnvironmentPort {
  id: string
  devEnvironmentId: string
  innerPort: number
  protocol: 'tcp' | 'udp'
  appProtocol: 'http' | 'https' | 'tcp' | 'udp' | null
  label: string | null
  source: 'declared' | 'detected'
  hostPort: number | null
  listening: boolean
  forwarded: boolean
  url: string | null
}

export interface EnvironmentBranch {
  name: string
  sha: string
  subject: string
}

export interface EnvironmentBranches {
  /** The branch checked out in the container, or null when its HEAD is detached. */
  current: string | null
  branches: EnvironmentBranch[]
}

/**
 * How a branch sync ended, whichever way it moved. An export is fast-forward
 * only in every direction, so `not-merged` — with a reason — is what a
 * divergence comes back as rather than anything being rewritten. Only an
 * import reaches `merged`: once it has committed what an agent left
 * uncommitted, the branch has genuinely diverged and a merge is the honest
 * tool. A conflict is `not-merged` with the side branch named, never a
 * half-merged tree left behind.
 */
export type BranchSyncResult = 'fast-forwarded' | 'created' | 'up-to-date' | 'merged' | 'not-merged'

export interface SyncedCommit {
  sha: string
  subject: string
}

/** What exporting one branch out of an environment did to the project's own checkout. */
export interface BranchExport {
  /** The remote-tracking ref the environment's branch was fetched into. */
  ref: string
  /** What that ref now points at. */
  sha: string
  /** What came over, newest first, relative to `into` (or to the previous tracking ref). */
  commits: SyncedCommit[]
  /** The local branch that was asked for, or null when only the fetch was. */
  into: string | null
  result: BranchSyncResult
  /** Why `into` was left alone, when it was. */
  reason?: string
}

/** One agent session, as an import plan refers to it. */
export interface ImportPlanSession {
  agentSessionId: string
  title: string
  /** Whether a turn is in flight right now. */
  busy: boolean
}

/**
 * What an import *would* do, worked out from the environment's observed state
 * before anything is touched. The executor carries this out rather than
 * deciding again, and the modal renders it — so the button cannot promise
 * something different from what the server does.
 */
export interface ImportPlan {
  /** The branch the caller asked the environment to have. */
  requested: string
  /** The ref in the project's checkout that will be sent. */
  from: string
  /** The branch the commits will land on in the environment. */
  branch: string
  /** True when `branch` is a side ref rather than the one asked for. */
  toSideBranch: boolean
  /** Why it is going to a side ref, when it is. */
  sideBranchReason: 'agent-mid-turn' | null
  /** The branch the environment has checked out, or null when its HEAD is detached. */
  checkedOut: string | null
  /** Paths that will be committed before anything else happens, capped, with the true total. */
  commitFirst: { paths: string[], total: number } | null
  /** Whether a merge into the checked-out branch will be attempted. */
  merge: boolean
  /** Every session that will be told what happened. */
  notify: ImportPlanSession[]
  /**
   * The one session that will be asked to merge by hand — when the changes land
   * on a side branch, or if the merge conflicts. Null when the environment has
   * no sessions, or when there will be nothing left to merge.
   */
  resolver: ImportPlanSession | null
}

/** What an import did, and what it told the agents working in the environment. */
export interface EnvironmentBranchImport extends BranchImport {
  /** The branch the caller asked for. Differs from `branch` when the import went to a side ref. */
  requested: string
  /** Why it was left on a side branch, when it was. */
  diverted?: string
  /** The commit an agent's uncommitted work was parked in before the merge, if there was any. */
  wip?: string | null
  /** The session that was asked to merge the changes by hand, when one was. */
  resolver?: ImportPlanSession | null
  /** The sessions told where the changes are, and how each one was reached. */
  notified: Array<{ agentSessionId: string, title: string, via: 'steer' | 'queue' | 'inbox' }>
}

/** What importing one branch into an environment did to the environment's checkout. */
export interface BranchImport {
  /** The branch in the environment that was written, or would have been. */
  branch: string
  /** The ref in the project's own checkout that was sent. */
  from: string
  /** What the environment's branch points at now — unchanged when nothing moved. */
  sha: string
  /** What crossed, newest first, relative to where the environment's branch stood. */
  commits: SyncedCommit[]
  result: BranchSyncResult
  /** Why the environment's branch was left alone, when it was. */
  reason?: string
}

export interface SessionModeInfo {
  id: string
  name: string
  description?: string | null
}

/**
 * One of the adapter's own `configOptions` selects, as it last reported it.
 *
 * ACP lets an agent publish whatever settings it has, so this is deliberately
 * not a named list: Claude Code offers `effort`, codex-acp `reasoning_effort`
 * and a `collaboration_mode` nobody else has, and both add a fast-mode toggle
 * only on the models that support one. Domo renders what arrives rather than
 * knowing any of them by name — the two it *does* know (`mode` and `model`)
 * have dedicated columns and are filtered out of this list.
 *
 * The set is per *session* and moves with the model: Claude Code drops the
 * effort option entirely on a model that has no effort levels, so this is
 * rewritten from the adapter's answer on every change rather than probed once.
 */
export interface SessionConfigOptionInfo {
  id: string
  name: string
  description?: string | null
  /** ACP's own hint: `thought_level` is where both adapters put reasoning effort. */
  category?: string | null
  currentValue: string | null
  options: Array<{ value: string, name: string, description?: string | null }>
}

/**
 * A durable row of the ACP session/update stream.
 *
 * Discrete events (`user_message`, `tool_call`, `turn_end`, …) are appended
 * once and never change. Streaming text is one row per message block — type
 * `agent_message` or `agent_thought`, payload `{ text, streaming }` — rewritten
 * in place as the deltas arrive and marked final when the block ends.
 */
export interface AgentEvent {
  id: string
  agentSessionId: string
  seq: number
  type: string
  payload: any
  createdAt: string
}

/** The event types whose rows are rewritten instead of appended. */
export type AgentStreamType = 'agent_message' | 'agent_thought'

export interface PendingPermission {
  id: string
  agentSessionId: string
  toolCallId: string | null
  title: string
  options: Array<{ optionId: string, name: string, kind: string }>
  toolCall: any
  createdAt: string
  resolvedAt: string | null
  resolvedOptionId: string | null
  /** `retired` is a request nobody ever answered, because its environment was retired under it. */
  resolvedBy: 'user' | 'voice-agent' | 'auto' | 'retired' | null
}

/**
 * How a message reaches an agent that may already be working.
 *
 * - `steer` injects it into the running turn through the adapter's
 *   `_session/steering` extension; with nothing running it is simply a prompt.
 * - `queue` parks it in `agent_inbox` until the turn ends; with nothing running
 *   it is prompted at once.
 * - `interrupt` cancels the running turn, waits for it to settle, then prompts.
 *
 * `steer` against an adapter that does not advertise steering falls back to
 * `interrupt`: the intent is "change course now", and queueing would be the one
 * thing it definitely does not mean.
 */
export type MessageDelivery = 'steer' | 'queue' | 'interrupt'

/** Who sent a message to an agent; a peer names itself. */
export type MessageOrigin = 'user' | 'voice' | 'system' | `agent:${string}` | `cron:${string}`

/**
 * A message waiting for an agent whose turn is still running.
 *
 * Domo owns this queue rather than the adapter. Both installed adapters accept
 * a second `session/prompt` mid-turn and queue it internally, but nothing in
 * Domo can see that queue and it does not survive a restart — so a message that
 * cannot be delivered now becomes a row instead.
 */
export interface AgentInboxMessage {
  id: string
  agentSessionId: string
  seq: number
  /** ACP content blocks, exactly as they would be sent to `session/prompt`. */
  content: any[]
  /** What the sender asked for. A row only exists because it could not happen yet. */
  delivery: MessageDelivery
  origin: MessageOrigin
  createdAt: string
  /** When it was handed to the adapter; null while it is still waiting. */
  deliveredAt: string | null
}

/** One agent asking to be told what another one is doing. */
export interface AgentSubscription {
  subscriberId: string
  targetId: string
  createdAt: string
}

export type CronScheduleType = 'cron' | 'once'
export type CronRunStatus = 'running' | 'delivered' | 'failed'

/** A durable prompt that wakes an existing coding-agent session on a schedule. */
export interface CronJob {
  id: string
  agentSessionId: string
  name: string
  prompt: string
  scheduleType: CronScheduleType
  /** Standard five-field cron expression. Set only for recurring jobs. */
  cronExpression: string | null
  /** IANA time zone used to interpret cronExpression. */
  timezone: string
  /** Original requested instant for a one-time job. */
  runAt: string | null
  enabled: boolean
  delivery: MessageDelivery
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: CronRunStatus | null
  lastError: string | null
  runCount: number
  createdBy: 'user' | 'voice' | `agent:${string}`
  createdAt: string
  updatedAt: string
}

export interface CronRun {
  id: string
  cronJobId: string
  scheduledFor: string
  startedAt: string
  finishedAt: string | null
  status: CronRunStatus
  outcome: string | null
  error: string | null
}

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  /** Which agents get this server wired in. */
  scope: 'voice' | 'coding' | 'both'
  createdAt: string
  updatedAt: string
}

export interface AppSettings {
  liveModel: string
  voiceName: string
  systemInstruction: string
  defaultCwd: string
  /** Tell the voice agent out loud when a coding agent finishes / needs input. */
  proactiveNotifications: boolean
  /** Auto-answer coding-agent permission prompts with the first "allow once" option. */
  autoApprovePermissions: boolean
  /**
   * The mode a new session of each adapter starts in. Claude Code and Codex
   * use it for permission policy; OpenCode uses it to choose a visible agent.
   * The ids and semantics are adapter-specific.
   */
  defaultAgentModes: Record<AgentAdapter, string>
  /**
   * The model a new session of each adapter starts on, when the session itself
   * names none. Empty means "whatever the adapter starts on".
   *
   * A session's own `model` column always wins: this is only consulted for a
   * row that asked for nothing, and if this names a model the adapter does not
   * offer, the session still starts — on whatever the adapter reports, with an
   * `error` event in its transcript saying so.
   *
   * The ids are the adapter's own and are not guessable (Claude Code lists
   * `haiku`, not `claude-haiku-4-5`), which is why the picker is fed from the
   * adapter's own probe rather than typed.
   */
  defaultAgentModels: Record<AgentAdapter, string>
  /**
   * Per-adapter defaults for the adapter's *own* settings, by config option id
   * — `{ 'claude-code': { effort: 'high' }, codex: { reasoning_effort: 'high' } }`.
   *
   * Keyed by id rather than by category because an adapter may publish several
   * options in one category, and applied best-effort: an option the adapter
   * does not offer on the session's model (Claude Code hides `effort` on a
   * model without effort levels) is skipped rather than failing the start.
   */
  defaultAgentConfig: Record<AgentAdapter, Record<string, string>>
  /**
   * An OpenCode console service-account key, for installs without a `.env`.
   *
   * The one credential in this object, and the reason it is here rather than in
   * the environment alone is that it is the *only* way a container session can
   * authenticate: OpenCode 2 keeps its own login in sqlite, and that login
   * rotates its refresh token, so nothing copies it. `NUXT_OPENCODE_API_KEY`
   * still wins when it is set.
   *
   * **Never returned by `GET /api/settings`** — that endpoint answers
   * `hasOpenCodeKey` instead, the way it already does for the Gemini and
   * Anthropic keys. Anything that spreads `AppSettings` into a response has to
   * take it back out.
   */
  openCodeApiKey: string
  /**
   * Whether OpenCode asks before touching a path outside the session's working
   * directory, per surface. `ask` is OpenCode's own behaviour and Domo then
   * writes no policy at all; `allow` suppresses it.
   *
   * Two values because the surfaces are not alike. An environment is a volume
   * Domo can re-create, so the prompts buy nothing and cost a prompt on every
   * out-of-directory read — an agent hits that constantly. The host is the
   * developer's real tree, where the same prompt does catch an accidental step
   * outside the project.
   *
   * It is a guardrail and not containment: `bash` crosses the same boundary
   * silently, measured. A `permission` block in the developer's own OpenCode
   * config wins over both.
   */
  openCodePermission: { host: OpenCodePermission, environment: OpenCodePermission }
  language: string
  /** Let the voice agent name conversations, and rename them as the topic moves. */
  autoTitle: boolean
  /** SSH target VS Code reaches Docker through; empty when it is the same machine. */
  vscodeSshHost: string
  /**
   * Paths under the host user's home directory bind-mounted into a new
   * environment's home: SSH keys, the git identity, CLI logins.
   */
  homeMounts: string[]
  /**
   * Mount a shared headless Chromium into new environments, so an agent can
   * open a dev server and look at it. Like every other mount, it is fixed when
   * the container is created.
   */
  browserTools: boolean
}

/** Server -> browser events on the /api/stream SSE channel. */
export type StreamEvent =
  | { type: 'agent-event', agentSessionId: string, event: AgentEvent }
  | { type: 'agent-changed', agentSessionId: string }
  | { type: 'agent-list-changed' }
  | { type: 'voice-message', sessionId: string, message: VoiceMessage }
  | { type: 'voice-session-changed', sessionId: string }
  | { type: 'voice-list-changed' }
  | { type: 'permission-changed', agentSessionId: string, permission: PendingPermission }
  | { type: 'agent-inbox-changed', agentSessionId: string, message: AgentInboxMessage }
  // TODO: published by writeUsageLimits/setUsageProviderState in repo.ts, but
  // nothing currently subscribes to it (checked every bus.subscribe call site)
  // — it reaches the browser through Electric instead. Either wire up a real
  // consumer or remove it. The `/api/stream` SSE channel this file claims to
  // feed doesn't exist anywhere in the codebase either; see bus.ts.
  | { type: 'usage-limits-changed', provider: UsageProviderId }
  | { type: 'cron-job-changed', cronJobId: string }
  | { type: 'settings-changed' }
  | { type: 'mcp-changed' }
  | { type: 'project-changed' }
  | { type: 'dev-environment-changed', devEnvironmentId: string }

/** Browser -> server messages on the voice WebSocket. */
export type VoiceClientMessage =
  | { type: 'start' }
  | { type: 'audio', data: string }
  | { type: 'audio-stream-end' }
  | { type: 'text', text: string }
  | { type: 'stop' }
  | { type: 'ping' }

/** Server -> browser messages on the voice WebSocket. */
export type VoiceServerMessage =
  | { type: 'status', status: VoiceSessionStatus, detail?: string }
  | { type: 'audio', data: string, sampleRate: number }
  | { type: 'interrupted' }
  | { type: 'turn-complete' }
  | { type: 'transcript', role: 'user' | 'assistant', text: string, final: boolean }
  | { type: 'tool', name: string, args: any, result?: any, phase: 'start' | 'end' }
  | { type: 'message', message: VoiceMessage }
  /** The conversation was handed over to a fresh one; follow it there. */
  | { type: 'session-changed', sessionId: string }
  | { type: 'error', message: string }
