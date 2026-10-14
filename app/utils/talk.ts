import type { AgentSession, Assistant } from '~~/shared/types'

/**
 * The assistant Talk opens: the one Settings names, else the one talked to
 * most recently, else none — and with none, Talk starts a fresh session.
 *
 * Archived assistants are never chosen, named or not: an archived one is a
 * record, and Talk is for carrying on a conversation.
 */
export function talkAssistant(
  assistants: Assistant[],
  sessions: AgentSession[],
  preferredId: string | null | undefined
): Assistant | null {
  const live = assistants.filter(assistant => !assistant.archived)
  const named = preferredId ? live.find(assistant => assistant.id === preferredId) : undefined
  if (named) return named
  const lastActive = (assistant: Assistant) => {
    const current = sessions.find(session => session.id === assistant.currentSessionId)
    return current?.lastActivityAt ?? current?.createdAt ?? assistant.updatedAt
  }
  return [...live].sort((a, b) => lastActive(b).localeCompare(lastActive(a)))[0] ?? null
}
