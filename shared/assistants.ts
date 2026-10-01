import type { AgentAdapter, HandoffReason } from './types'

/**
 * What the server and the browser both have to agree on about assistants:
 * the markers on text Domo writes into a session on the assistant's behalf,
 * which the transcript renders as something other than the human talking.
 */

/**
 * Wraps the assistant's identity and handoff note when the harness has no
 * system prompt to put them in: the block rides on the session's first
 * prompt, and the transcript hides it.
 */
export const ASSISTANT_CONTEXT_OPEN = '<domo-assistant-context>'
export const ASSISTANT_CONTEXT_CLOSE = '</domo-assistant-context>'

/** Starts the message that asks a session to write its handoff note. */
export const HANDOFF_REQUEST_PREFIX = '[Domo: hand-off]'

/** Starts the prompt a session begins on when the one before it asked to keep working. */
export const HANDOFF_CONTINUE_PREFIX = '[Domo: continuing after hand-off]'

export function isAssistantContext(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(ASSISTANT_CONTEXT_OPEN)
}

export function isHandoffRequest(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(HANDOFF_REQUEST_PREFIX)
}

export function isHandoffContinuation(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(HANDOFF_CONTINUE_PREFIX)
}

/**
 * Harnesses that take a system prompt over ACP. Claude Code reads
 * `_meta.systemPrompt` on `session/new` and `session/load`; codex-acp and
 * OpenCode have no such field, so their sessions get the hidden block instead.
 */
export function supportsSystemPrompt(adapter: AgentAdapter): boolean {
  return adapter === 'claude-code'
}

/** How a handoff is described to the human, after "Handed off: ". */
export const HANDOFF_REASON_LABELS: Record<HandoffReason, string> = {
  user: 'you asked for a fresh start',
  context: 'the context window was filling up',
  agent: 'the conversation moved on',
  unavailable: 'the previous session could no longer run'
}

/** Percent of the context window. Below the lower bound a handoff would come every few turns. */
export const HANDOFF_THRESHOLD_MIN = 30
export const HANDOFF_THRESHOLD_MAX = 95
export const DEFAULT_HANDOFF_THRESHOLD = 75

/** A data URL the browser made by shrinking the picture; a cap keeps the synced row small. */
export const MAX_AVATAR_CHARS = 200_000
export const MAX_PERSONA_CHARS = 20_000
export const MAX_ASSISTANT_NAME_CHARS = 60
