import type { AgentSession } from '../../../shared/types'

/**
 * The guard that makes "read-only" mean read-only, and nothing else.
 *
 * Deliberately a leaf: it imports types and nothing at all. Every module that
 * has to refuse a retired session — `repo.ts`, `AgentRuntime`, the mesh tools,
 * the cron scheduler, the HTTP routes — can import it without any of them
 * importing each other, which is the only way a check this widely spread can
 * avoid a cycle. The orchestration of *retiring* lives a layer up, in
 * `server/lib/session-retention.ts`, where it is allowed to know about the
 * adapter manager.
 *
 * `statusCode` and `statusMessage` are read straight off a thrown Error by
 * h3's `createError`, so a route that does nothing at all still answers 409
 * rather than 500. The long explanation stays in `message`: `statusMessage`
 * becomes a header and has to stay short and plain.
 */
export class RetiredSessionError extends Error {
  readonly statusCode = 409
  readonly statusMessage = 'Agent session is retired'
  readonly data: { retiredAt: string | null }

  constructor(message: string, retiredAt: string | null = null) {
    super(message)
    this.name = 'RetiredSessionError'
    this.data = { retiredAt }
  }
}

export function isRetired(session: Pick<AgentSession, 'retiredAt'> | null | undefined): boolean {
  return !!session?.retiredAt
}

/**
 * Refuse anything that would put a retired session back to work.
 *
 * `what` completes "… is retired; <what> is not possible." — name the action
 * the caller was trying to take, because this message is what a coding agent
 * on the other end of the mesh, or a person in a toast, has to act on.
 */
export function assertSessionLive(
  session: Pick<AgentSession, 'id' | 'title' | 'retiredAt'> | null | undefined,
  what: string
): void {
  if (!session || !session.retiredAt) return
  throw new RetiredSessionError(
    `Agent session "${session.title}" (${session.id}) is retired and read-only; ${what} is not possible. `
    + 'Its transcript is still there to read, and it can be revived if the environment it ran in still exists.',
    session.retiredAt
  )
}
