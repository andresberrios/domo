import { access, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { AgentSession, EnvironmentLeftover, Project } from '../../shared/types'
import { acpManager } from './acp/manager'
import { retireEnvironment } from './dev-environments'
import { normalizeCwd } from './paths'
import {
  appendAgentEvent,
  cancelPendingPermissions,
  createProject,
  disableCronJobsForAgent,
  listAgentSessionsInEnvironment,
  listDevEnvironments,
  pruneRetiredRecords,
  removeAllAgentSubscriptions,
  retireProjectRow
} from './repo'

/**
 * Project and environment lifecycle, one level above `dev-environments.ts`.
 *
 * Retiring an environment destroys its container, its workspace volume and its
 * image, and **keeps every row**: the environment's own, and the whole
 * transcript of each coding agent that ran inside it. An agent session is a
 * record of work — what was tried, what was decided, what broke — and it stays
 * worth reading long after the container is gone, so nothing here deletes one.
 *
 * What is torn down instead is only *forward-looking* state: schedules that
 * would fire at an agent that cannot answer, subscriptions that would compose
 * notes about it, a permission request nobody will ever resolve. Those sessions
 * are **not** archived — archiving is about whether a session shows up, and
 * that is the user's call, not a side effect of losing a container. They stay
 * visible and simply cannot be started, which `sessionStartability` derives
 * from the retired environment row rather than from anything written on them.
 *
 * This is where the adapter manager may be imported and `dev-environments.ts`
 * is where it may not — importing `acpManager` there would cycle straight back
 * through it.
 */

export async function createProjectFromPath(input: { name?: string, repoPath: string }): Promise<Project> {
  const repoPath = normalizeCwd(input.repoPath)
  try {
    if (!(await stat(repoPath)).isDirectory()) throw new Error('not a directory')
    await access(join(repoPath, '.git'))
  } catch {
    throw new Error('Repository path must be a local Git checkout.')
  }
  return createProject({ name: input.name?.trim() || basename(repoPath), repoPath })
}

export interface EnvironmentRetirement {
  /** The sessions that can no longer be started. Still visible, still readable. */
  sessions: AgentSession[]
  cronJobsDisabled: number
  subscriptionsRemoved: number
  permissionsCancelled: number
  /**
   * The Docker resources the cleanup could not remove, and why. Empty is the
   * normal answer; anything here is gigabytes still on the disk, so it is
   * reported rather than swallowed. It stays on the environment row and is
   * retried — a retirement is never undone by one, and never claims to have
   * finished when it has not.
   */
  leftovers: EnvironmentLeftover[]
}

/**
 * Stand down one session whose environment is going away.
 *
 * Deliberately does not touch `archived` or anything else that describes what
 * happened: the events, the inbox rows and the resolved permissions are the
 * record, and the record is the point.
 */
async function standDown(
  session: AgentSession
): Promise<Omit<EnvironmentRetirement, 'sessions' | 'leftovers'>> {
  // The adapter first: everything below describes a session that has stopped,
  // and it has not stopped until the process is down.
  acpManager.stop(session.id)

  const [cronJobsDisabled, subscriptionsRemoved, permissionsCancelled] = await Promise.all([
    disableCronJobsForAgent(session.id),
    removeAllAgentSubscriptions(session.id),
    cancelPendingPermissions(session.id)
  ])
  // The last line of the transcript says why it ends here.
  await appendAgentEvent(session.id, 'environment_retired', {
    devEnvironmentId: session.devEnvironmentId,
    cronJobsDisabled,
    subscriptionsRemoved,
    permissionsCancelled
  })
  return { cronJobsDisabled, subscriptionsRemoved, permissionsCancelled }
}

/**
 * Retire an environment: its sessions are stood down, then the container and
 * its volumes are destroyed and the row is kept.
 *
 * The sessions go first. Standing one down stops its adapter, and an adapter
 * still holding a `docker exec` against a container being removed is the one
 * ordering here that is not cosmetic.
 */
export async function retireProjectEnvironment(environmentId: string): Promise<EnvironmentRetirement> {
  const result: EnvironmentRetirement = {
    sessions: [],
    cronJobsDisabled: 0,
    subscriptionsRemoved: 0,
    permissionsCancelled: 0,
    leftovers: []
  }
  for (const session of await listAgentSessionsInEnvironment(environmentId)) {
    const counts = await standDown(session)
    result.sessions.push(session)
    result.cronJobsDisabled += counts.cronJobsDisabled
    result.subscriptionsRemoved += counts.subscriptionsRemoved
    result.permissionsCancelled += counts.permissionsCancelled
  }
  const cleanup = await retireEnvironment(environmentId)
  result.leftovers = cleanup.leftovers.map(({ kind, name, error }) => ({ kind, name, error }))
  return result
}

/**
 * Retire a project and every environment under it.
 *
 * The project row is kept for the same reason each environment's is: an
 * environment that outlived its project would be an orphan, and the sessions
 * below it could no longer say where they ran.
 */
export async function retireProjectCascade(projectId: string): Promise<{ leftovers: EnvironmentLeftover[] }> {
  const leftovers: EnvironmentLeftover[] = []
  for (const environment of await listDevEnvironments(projectId)) {
    leftovers.push(...(await retireProjectEnvironment(environment.id)).leftovers)
  }
  await retireProjectRow(projectId)
  // A project nothing ever ran in leaves no record behind at all.
  await pruneRetiredRecords()
  // Ten environments retired in one go is exactly when one silent failure
  // disappears, so what is still on the disk is carried back out of the loop
  // rather than summed into a success.
  return { leftovers }
}
