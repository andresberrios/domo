/**
 * Domain types shared between the Nitro server and the Nuxt app.
 */

export type VoiceSessionStatus = 'idle' | 'live' | 'error'

export interface VoiceSession {
  id: string
  title: string
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

export interface AgentSession {
  id: string
  voiceSessionId: string | null
  adapter: 'claude-code'
  acpSessionId: string | null
  title: string
  cwd: string
  status: AgentSessionStatus
  modeId: string | null
  modes: SessionModeInfo[] | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  lastActivityAt: string | null
  archived: boolean
  /** Rolling summary of the agent's most recent output, for the voice agent. */
  summary: string | null
}

export interface SessionModeInfo {
  id: string
  name: string
  description?: string | null
}

/** A durable row of the ACP session/update stream. */
export interface AgentEvent {
  id: string
  agentSessionId: string
  seq: number
  type: string
  payload: any
  createdAt: string
}

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
  defaultAgentMode: string
  language: string
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
  | { type: 'error', message: string }
