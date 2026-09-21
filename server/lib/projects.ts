import { access, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Project } from '../../shared/types'
import { acpManager } from './acp/manager'
import { removeEnvironment } from './dev-environments'
import { normalizeCwd } from './paths'
import { createProject, deleteAgentSession, deleteProject, listAgentSessions, listDevEnvironments } from './repo'

/**
 * Project and environment lifecycle, one level above `dev-environments.ts`: this is
 * where an environment's coding-agent sessions get torn down alongside its container,
 * so every caller (the HTTP API, the voice agent, the agent mesh) shares one cascade
 * instead of three copies of it.
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

/** Stop and remove every coding agent session running in an environment before it is torn down. */
async function clearEnvironmentAgents(environmentId: string): Promise<void> {
  const agents = (await listAgentSessions(true)).filter(agent => agent.devEnvironmentId === environmentId)
  for (const agent of agents) {
    acpManager.stop(agent.id)
    await deleteAgentSession(agent.id)
  }
}

export async function removeProjectEnvironment(environmentId: string): Promise<void> {
  await clearEnvironmentAgents(environmentId)
  await removeEnvironment(environmentId)
}

export async function removeProjectCascade(projectId: string): Promise<void> {
  const environments = await listDevEnvironments(projectId)
  for (const environment of environments) {
    await removeProjectEnvironment(environment.id)
  }
  await deleteProject(projectId)
}
