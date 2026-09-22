import { acpManager } from './acp/manager'
import { RetiredSessionError } from './acp/retirement'
import {
  appendAgentEvent,
  cancelPendingPermissions,
  deleteAgentSession,
  disableCronJobsForAgent,
  getAgentSession,
  getDevEnvironment,
  listAgentSessionsInEnvironment,
  pruneEmptyTombstones,
  removeAllAgentSubscriptions,
  retireAgentSessionRow,
  reviveAgentSessionRow
} from './repo'
import { revivalState } from '../../shared/retention'
import type { AgentRetirementReason, AgentSession } from '../../shared/types'

/**
 * Retiring a coding agent session, and bringing one back.
 *
 * An agent session is a record of work — what was tried, what was decided, what
 * broke — and it stays worth reading long after the container it ran in is
 * gone. So nothing deletes one any more: `DELETE /api/agents/:id`, deleting the
 * environment it ran in and deleting the project above that all end here, and
 * all three leave the row and every one of its `agent_events` in place.
 *
 * This sits one layer above `acp/manager.ts` for the same reason
 * `projects.ts` does: it has to stop the adapter before it writes the row, and
 * a manager that imported this would cycle. The guard the manager itself uses
 * is the leaf `acp/retirement.ts`, which imports nothing.
 *
 * Everything torn down here is *forward-looking* state — schedules that would
 * fire at a session that cannot answer, subscriptions that would compose notes
 * for it, a permission request nobody will ever answer. Nothing that describes
 * what happened is touched: the events, the inbox rows and the resolved
 * permissions are the record, and the record is the point.
 */

export interface RetirementOutcome {
  session: AgentSession
  /** What was stood down with it, so a caller can say so rather than guess. */
  cronJobsDisabled: number
  subscriptionsRemoved: number
  permissionsCancelled: number
}

export async function retireAgentSession(
  id: string,
  reason: AgentRetirementReason
): Promise<RetirementOutcome | null> {
  const existing = await getAgentSession(id)
  if (!existing) return null
  if (existing.retiredAt) {
    return { session: existing, cronJobsDisabled: 0, subscriptionsRemoved: 0, permissionsCancelled: 0 }
  }

  // The adapter first: everything below writes rows that describe a session
  // that is over, and it is only over once the process is down.
  acpManager.stop(id)

  const [cronJobsDisabled, subscriptionsRemoved, permissionsCancelled] = await Promise.all([
    disableCronJobsForAgent(id),
    removeAllAgentSubscriptions(id),
    cancelPendingPermissions(id)
  ])

  const session = (await retireAgentSessionRow(id, reason))!
  // Appended after the row, so the last line of the transcript is something
  // that has already happened rather than something about to.
  await appendAgentEvent(id, 'retired', { reason, cronJobsDisabled, subscriptionsRemoved, permissionsCancelled })

  return { session, cronJobsDisabled, subscriptionsRemoved, permissionsCancelled }
}

/** Retire every session that was running in an environment being torn down. */
export async function retireEnvironmentSessions(
  devEnvironmentId: string,
  reason: AgentRetirementReason
): Promise<AgentSession[]> {
  const retired: AgentSession[] = []
  for (const session of await listAgentSessionsInEnvironment(devEnvironmentId)) {
    const outcome = await retireAgentSession(session.id, reason)
    if (outcome) retired.push(outcome.session)
  }
  return retired
}

/**
 * Put a retired session back into service, if the place it ran still exists.
 *
 * Refused rather than attempted when it does not: an environment deletion took
 * the container, the workspace volume and the adapter's own session storage
 * with it, and a revival that spawned a fresh adapter in a directory that is
 * not there would fail several layers down with something unreadable.
 *
 * It does not start the adapter. Reviving is a decision about the row;
 * starting is a decision about a process and, for a container session, about
 * waking a whole environment. The Start button covers the second.
 */
export async function reviveAgentSession(id: string): Promise<AgentSession | null> {
  const session = await getAgentSession(id)
  if (!session) return null
  if (!session.retiredAt) {
    throw new RetiredSessionError(`Agent session ${id} is not retired.`, null)
  }

  const environment = session.devEnvironmentId
    ? await getDevEnvironment(session.devEnvironmentId)
    : null
  const state = revivalState(session, environment)
  if (!state.revivable) {
    throw new RetiredSessionError(
      `Agent session "${session.title}" (${session.id}) cannot be revived. ${state.reason}`,
      session.retiredAt
    )
  }

  const revived = (await reviveAgentSessionRow(id))!
  await appendAgentEvent(id, 'revived', { from: session.retiredReason })
  return revived
}

/**
 * Really delete a retired session, transcript and all.
 *
 * The one escape hatch, and it is deliberately only reachable *through*
 * retirement: you cannot skip the tombstone by accident, and by the time this
 * is offered the session is already something the user has looked at and
 * decided about. Purging is also what lets the tombstones above a session go —
 * see `pruneEmptyTombstones`.
 */
export async function purgeAgentSession(id: string): Promise<boolean> {
  const session = await getAgentSession(id)
  if (!session) return false
  if (!session.retiredAt) {
    throw new RetiredSessionError(
      `Agent session "${session.title}" (${session.id}) is still live. Retire it before deleting it permanently.`,
      null
    )
  }
  acpManager.stop(id)
  await deleteAgentSession(id)
  await pruneEmptyTombstones()
  return true
}
