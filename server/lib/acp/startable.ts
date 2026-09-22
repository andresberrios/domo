import { sessionStartability } from '../../../shared/retention'
import type { AgentSession, DevEnvironment } from '../../../shared/types'

/**
 * The guard that makes "cannot be started" mean it, on every path that could
 * start an adapter.
 *
 * Deliberately a leaf: it imports the pure rule and types, and nothing else.
 * Every module that has to refuse — `repo.ts`, `AgentRuntime`, the mesh tools,
 * the cron scheduler, the HTTP routes — imports this without any of them
 * importing each other, which is the only way a check this widely spread stays
 * free of cycles. Doing the lookups is the caller's job for the same reason.
 *
 * `statusCode` and `statusMessage` are read straight off a thrown Error by
 * h3's `createError`, so a route that does nothing at all still answers 409
 * rather than 500. The long explanation stays in `message`: `statusMessage`
 * becomes a header and has to stay short and plain.
 */
export class UnstartableSessionError extends Error {
  readonly statusCode = 409
  readonly statusMessage = 'Agent session cannot be started'
  readonly data: { reason: string }

  constructor(message: string, reason: string) {
    super(message)
    this.name = 'UnstartableSessionError'
    this.data = { reason }
  }
}

/**
 * Refuse anything that would put an unstartable session to work.
 *
 * `what` completes "… <what> is not possible" — name the action the caller was
 * trying to take, because this message is what a coding agent on the other end
 * of the mesh, or a person in a toast, has to act on.
 */
export function assertSessionStartable(
  session: Pick<AgentSession, 'id' | 'title' | 'cwd' | 'devEnvironmentId'> | null | undefined,
  environment: Pick<DevEnvironment, 'name' | 'retiredAt'> | null,
  cwdPresent: boolean | null,
  what: string
): void {
  if (!session) return
  const state = sessionStartability(session, environment, cwdPresent)
  if (state.startable) return
  throw new UnstartableSessionError(
    `Agent session "${session.title}" (${session.id}) can no longer be started, so ${what} is not possible. `
    + `${state.reason} Its transcript is kept and stays readable.`,
    state.reason
  )
}
