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

export type AgentAdapter = 'claude-code' | 'codex'

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
  lastError: string | null
  createdAt: string
  updatedAt: string
  lastActivityAt: string | null
  archived: boolean
  /** Rolling summary of the agent's most recent output, for the voice agent. */
  summary: string | null
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
   * The permission mode a new session of each adapter starts in. Per adapter,
   * because the two share no mode ids at all: Claude Code offers `default` /
   * `acceptEdits` / `plan` / `auto` / `bypassPermissions`, Codex `read-only` /
   * `agent` / `agent-full-access`. One string could only ever be right for one
   * of them, and it was — the other silently kept the adapter's own default.
   */
  defaultAgentModes: Record<AgentAdapter, string>
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
