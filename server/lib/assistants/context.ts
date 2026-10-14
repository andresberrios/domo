import {
  getAgentSession,
  getAssistant,
  hasUserMessage,
  latestAgentEvent,
  listAgentEventsWindow
} from '../repo'
import { isSpokenNote } from '../../../shared/agent-voice'
import {
  ASSISTANT_CONTEXT_CLOSE,
  ASSISTANT_CONTEXT_OPEN,
  isAssistantContext,
  isHandoffContinuation,
  isHandoffRequest,
  supportsSystemPrompt
} from '../../../shared/assistants'
import type { AgentSession, Assistant, HandoffReason } from '../../../shared/types'

/**
 * What a session of an assistant is told about who it is and where it left
 * off. Imports nothing but the repo, so the adapter manager can ask without a
 * cycle: the lifecycle (handoffs, new sessions) lives in `./index.ts`.
 */

/** The `handoff` event a session starts with: the note the one before it wrote. */
export interface HandoffPayload {
  note: string
  reason: HandoffReason
  fromSessionId: string
  /** The last words of the session before, verbatim, oldest first. */
  recent: Array<{ role: 'human' | 'assistant', text: string }>
}

function identity(assistant: Assistant): string {
  return [
    '# Who you are',
    `You are "${assistant.name}", a persistent assistant the human set up in Domo. You are not a one-off `
    + 'session: you live across many coding sessions. When one fills up or the conversation moves to a new topic, '
    + 'you write a handoff note and carry on in a fresh session that starts from it. To the human this is one '
    + 'continuous conversation with you, so do not talk about sessions or handoffs unless they ask.',
    '',
    assistant.persona.trim() || '(The human has not described you further.)',
    '',
    '# Continuity',
    '- Call the `hand_off` tool of the domo MCP server when the human asks you to clean up, reset or compact your '
    + 'context, or when the conversation has clearly moved on to an unrelated topic and what came before no longer '
    + 'helps. Write the note for yourself, then end your turn. Domo may also ask you to hand off when your context '
    + 'is nearly full.',
    '- Scheduled tasks you create with schedule_task (no agentId) belong to you, not to this session, and keep '
    + 'firing after a handoff.'
  ].join('\n')
}

/** Why a session began, as the assistant itself reads it: the UI's labels say "you" for the human. */
const HANDOFF_REASONS: Record<HandoffReason, string> = {
  user: 'the human asked for a fresh start',
  context: 'your context window was filling up',
  agent: 'you chose to start fresh',
  unavailable: 'it could no longer run'
}

function whereYouLeftOff(handoff: HandoffPayload, at: string): string {
  const lines = [
    '# Where you left off',
    handoff.reason === 'unavailable'
      ? `Domo started this session at ${at} because your previous one could no longer run:`
      : `Your previous session handed off to this one at ${at} because ${HANDOFF_REASONS[handoff.reason]}. `
        + 'The note it wrote for you:',
    '',
    handoff.note.trim()
  ]
  if (handoff.recent.length) {
    lines.push('', 'The last exchange, word for word:')
    for (const entry of handoff.recent) {
      lines.push('', `${entry.role === 'human' ? 'Human' : 'You'}: ${entry.text}`)
    }
  }
  lines.push('', 'Carry on from here as if nothing happened.')
  return lines.join('\n')
}

/** Everything a session of this assistant should know before its first turn. */
async function assistantContext(session: AgentSession): Promise<string | null> {
  if (!session.assistantId) return null
  const assistant = await getAssistant(session.assistantId)
  if (!assistant) return null
  const parts = [identity(assistant)]
  const handoff = await latestAgentEvent(session.id, 'handoff')
  if (handoff?.payload?.note) parts.push(whereYouLeftOff(handoff.payload as HandoffPayload, handoff.createdAt))
  return parts.join('\n\n')
}

/**
 * The text to append to the harness's system prompt, for a harness that has
 * one. Asked on every attach, so a persona edited since takes effect the next
 * time the session starts.
 */
export async function assistantSystemPrompt(session: AgentSession): Promise<string | null> {
  if (!supportsSystemPrompt(session.adapter)) return null
  return assistantContext(session)
}

/**
 * For a harness without a system prompt: the session's first prompt carries
 * the same context, in a block the transcript hides. Later prompts go as they
 * are; the adapter keeps the first one in its own history.
 */
export async function primeFirstPrompt(session: AgentSession, content: any[]): Promise<any[]> {
  if (!session.assistantId || supportsSystemPrompt(session.adapter)) return content
  if (await hasUserMessage(session.id)) return content
  const context = await assistantContext(session)
  if (!context) return content
  return [{
    type: 'text',
    text: `${ASSISTANT_CONTEXT_OPEN}\nContext from Domo, not from the human. Do not answer it; answer the message `
      + `after it.\n\n${context}\n${ASSISTANT_CONTEXT_CLOSE}`
  }, ...content]
}

/**
 * Where a message for this session should really go. A session of an
 * assistant that has since handed off is a closed chapter: whatever is sent to
 * it is meant for the assistant, so it goes to the current session.
 */
export async function currentSessionFor(agentSessionId: string): Promise<string> {
  const session = await getAgentSession(agentSessionId)
  if (!session?.assistantId) return agentSessionId
  const assistant = await getAssistant(session.assistantId)
  return assistant?.currentSessionId ?? agentSessionId
}

function words(content: any[]): string {
  return (content ?? [])
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text as string)
    .filter(text => !isAssistantContext(text) && !isSpokenNote(text))
    .join('\n')
    .trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * The newest messages of a session, verbatim, before it was asked to hand
 * off: what the next session reads after the note, so the thread does not
 * lose the exact words it was in the middle of. The request and the note
 * writing are left out.
 */
export async function recentExchange(
  agentSessionId: string,
  limit = 4
): Promise<HandoffPayload['recent']> {
  const events = await listAgentEventsWindow(agentSessionId, {
    types: ['user_message', 'agent_message'],
    limit: 40
  })
  // Newest first. Skip everything from the hand-off request on.
  const lastRequest = events.findIndex(event =>
    event.type === 'user_message' && (event.payload?.content ?? []).some((block: any) => isHandoffRequest(block?.text)))
  const before = lastRequest >= 0 ? events.slice(lastRequest + 1) : events
  const out: HandoffPayload['recent'] = []
  for (const event of before) {
    if (out.length >= limit) break
    if (event.type === 'user_message') {
      const text = words(event.payload?.content)
      if (!text || isHandoffContinuation(text)) continue
      out.push({ role: 'human', text: clip(text, 1500) })
    } else {
      const text = String(event.payload?.text ?? '').trim()
      if (text) out.push({ role: 'assistant', text: clip(text, 1500) })
    }
  }
  return out.reverse()
}
