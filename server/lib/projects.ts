import { access, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Project } from '../../shared/types'
import { removeEnvironment } from './dev-environments'
import { normalizeCwd } from './paths'
import { createProject, listDevEnvironments, pruneEmptyTombstones, softDeleteProject } from './repo'
import { retireEnvironmentSessions } from './session-retention'

/**
 * Project and environment lifecycle, one level above `dev-environments.ts`: this is
 * where an environment's coding-agent sessions are stood down alongside its container,
 * so every caller (the HTTP API, the voice agent, the agent mesh) shares one cascade
 * instead of three copies of it.
 *
 * The cascade used to *delete* those sessions, which threw away the only record
 * of what happened inside the environment at exactly the moment the environment
 * stopped being able to tell you. It retires them instead: the container, the
 * workspace volume and the image really do go, and the rows — the session, its
 * whole `agent_events` log, and a tombstone for the environment and project
 * they name — stay. See `server/lib/session-retention.ts`.
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

/**
 * Tear an environment down: its sessions are retired, then the container and
 * its volumes are removed and the row is tombstoned.
 *
 * The sessions go first. Retiring stops each adapter, and an adapter still
 * holding a `docker exec` against a container being removed is the one ordering
 * here that is not cosmetic.
 */
export async function removeProjectEnvironment(
  environmentId: string,
  reason: 'environment-deleted' | 'project-deleted' = 'environment-deleted'
): Promise<void> {
  await retireEnvironmentSessions(environmentId, reason)
  await removeEnvironment(environmentId)
}

export async function removeProjectCascade(projectId: string): Promise<void> {
  const environments = await listDevEnvironments(projectId)
  for (const environment of environments) {
    await removeProjectEnvironment(environment.id, 'project-deleted')
  }
  await softDeleteProject(projectId)
  // A project nothing retired ever ran in leaves no tombstone behind at all.
  await pruneEmptyTombstones()
}
