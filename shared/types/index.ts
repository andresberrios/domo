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

export type BranchExportResult = 'fast-forwarded' | 'created' | 'up-to-date' | 'not-merged'

export interface ExportedCommit {
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
  commits: ExportedCommit[]
  /** The local branch that was asked for, or null when only the fetch was. */
  into: string | null
  result: BranchExportResult
  /** Why `into` was left alone, when it was. */
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
  resolvedBy: 'user' | 'voice-agent' | 'auto' | null
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
   * Per-adapter defaults for the adapter's *own* settings, by config option id
   * — `{ 'claude-code': { effort: 'high' }, codex: { reasoning_effort: 'high' } }`.
   *
   * Keyed by id rather than by category because an adapter may publish several
   * options in one category, and applied best-effort: an option the adapter
   * does not offer on the session's model (Claude Code hides `effort` on a
   * model without effort levels) is skipped rather than failing the start.
   */
  defaultAgentConfig: Record<AgentAdapter, Record<string, string>>
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
