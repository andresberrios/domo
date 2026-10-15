import type { AgentSession, DevEnvironment, PendingPermission, Project } from '~~/shared/types'
import { isUnderRepo } from './sessionGroups'

/**
 * What one session's header says about where it works and who it works with,
 * read off rows the browser already has.
 */

/** The project a session works in: its environment's, else the checkout its directory is under. */
export function sessionProject(
  session: Pick<AgentSession, 'cwd' | 'devEnvironmentId'>,
  environment: DevEnvironment | null,
  projects: Project[]
): Project | null {
  if (session.devEnvironmentId) {
    return environment ? projects.find(project => project.id === environment.projectId) ?? null : null
  }
  // The deepest checkout wins, for a project nested inside another.
  return projects
    .filter(project => isUnderRepo(session.cwd, project.repoPath))
    .sort((a, b) => b.repoPath.length - a.repoPath.length)[0] ?? null
}

/** The sessions this one started over the mesh, most recent first. */
export function startedSessions(sessionId: string, sessions: AgentSession[]): AgentSession[] {
  return sessions.filter(session => session.spawnedBy === sessionId)
}

/**
 * The sessions this one follows, except those it started: those are in the
 * started list already, and saying them twice says nothing more.
 */
export function followedSessions(
  sessionId: string,
  follows: Array<{ subscriberId: string, targetId: string }>,
  sessions: AgentSession[]
): AgentSession[] {
  const targets = new Set(follows.filter(follow => follow.subscriberId === sessionId).map(follow => follow.targetId))
  return sessions.filter(session => targets.has(session.id) && session.spawnedBy !== sessionId)
}

/** How many permission requests among `sessions` are still unanswered. */
export function pendingAmong(sessions: AgentSession[], pending: PendingPermission[]): number {
  const ids = new Set(sessions.map(session => session.id))
  return pending.filter(permission => ids.has(permission.agentSessionId)).length
}

/** A session's settings as "name: value" lines, by the names its adapter gave them. */
export function sessionSettingsSummary(session: Pick<AgentSession, 'model' | 'modeId' | 'modes' | 'config' | 'configOptions'>) {
  const options = (session.configOptions ?? []).map((option) => {
    const value = session.config?.[option.id] ?? option.currentValue
    return {
      id: option.id,
      label: option.name,
      value: option.options.find(entry => entry.value === value)?.name ?? value ?? null,
      effort: option.category === 'thought_level'
    }
  }).filter(option => option.value)
  const mode = session.modes?.find(entry => entry.id === session.modeId)?.name ?? session.modeId ?? null
  return {
    model: session.model,
    mode,
    options,
    /** The reasoning effort, the one setting worth naming beside the model. */
    effort: options.find(option => option.effort)?.value ?? null
  }
}

/** The last path segment, what a folder is called. */
export function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || '/'
}
