import type { AgentEvent, AgentInboxMessage, PendingPermission } from '~~/shared/types'

/**
 * Builders for the two append-only logs. `buildTranscript()` only cares about
 * `type`, `payload` and the order, so the noise (ids, timestamps) is generated.
 */

let counter = 0

export function agentEvent(type: string, payload: any = {}, overrides: Partial<AgentEvent> = {}): AgentEvent {
  counter += 1
  return {
    id: `ev_${counter}`,
    agentSessionId: 'ag_test',
    seq: counter,
    type,
    payload,
    createdAt: new Date(1700000000000 + counter * 1000).toISOString(),
    ...overrides
  }
}

export function textChunk(text: string): AgentEvent {
  return agentEvent('agent_message_chunk', { content: { type: 'text', text } })
}

export function thoughtChunk(text: string): AgentEvent {
  return agentEvent('agent_thought_chunk', { content: { type: 'text', text } })
}

export function userMessage(text: string, extra: any[] = []): AgentEvent {
  return agentEvent('user_message', { content: [{ type: 'text', text }, ...extra] })
}

export function permission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  counter += 1
  return {
    id: `pm_${counter}`,
    agentSessionId: 'ag_test',
    toolCallId: null,
    title: 'Run a command',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ],
    toolCall: null,
    createdAt: new Date(1700000000000 + counter * 1000).toISOString(),
    resolvedAt: null,
    resolvedOptionId: null,
    resolvedBy: null,
    ...overrides
  }
}

export function inboxMessage(overrides: Partial<AgentInboxMessage> = {}): AgentInboxMessage {
  counter += 1
  return {
    id: `in_${counter}`,
    agentSessionId: 'ag_test',
    seq: counter,
    content: [{ type: 'text', text: 'then push it' }],
    delivery: 'queue',
    origin: 'user',
    createdAt: new Date(1700000000000 + counter * 1000).toISOString(),
    deliveredAt: null,
    ...overrides
  }
}
