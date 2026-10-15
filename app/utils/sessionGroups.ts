import { sessionStartability } from '~~/shared/retention'
import type { AgentSession, DevEnvironment, Project } from '~~/shared/types'

/**
 * Coding agent sessions the way the sidebar shows them: by project, then by
 * environment, with an environment that holds a single session folded into
 * that session's entry. Every place that lists or offers sessions builds from
 * this, so they cannot disagree about where a session belongs.
 */

/** Whether a host session's directory is the checkout at `repoPath` or inside it. */
export function isUnderRepo(cwd: string, repoPath: string): boolean {
  const c = cwd.replace(/\/+$/, '')
  const r = repoPath.replace(/\/+$/, '')
  return c === r || c.startsWith(`${r}/`)
}

export function sessionsByEnvironment(sessions: AgentSession[]): Map<string, AgentSession[]> {
  const map = new Map<string, AgentSession[]>()
  for (const session of sessions) {
    if (!session.devEnvironmentId) continue
    const list = map.get(session.devEnvironmentId)
    if (list) list.push(session)
    else map.set(session.devEnvironmentId, [session])
  }
  return map
}

/**
 * What can be offered as a target: not archived, not one of an assistant's
 * sessions (an assistant is offered as itself), and still able to run.
 */
export function offerableSessions(sessions: AgentSession[], environments: DevEnvironment[]): AgentSession[] {
  const byId = new Map(environments.map(environment => [environment.id, environment]))
  return sessions.filter(session => !session.archived
    && !session.assistantId
    && sessionStartability(session, (session.devEnvironmentId && byId.get(session.devEnvironmentId)) || null).startable)
}

/** One session; `environment` is set when it is the only session there, so the two read as one entry. */
export interface SessionEntry {
  session: AgentSession
  environment: DevEnvironment | null
}

/**
 * A run of entries under one heading. A project's own group holds its host
 * sessions and its single-session environments; an environment with several
 * sessions has a group of its own after it. `project` is null for sessions in
 * a directory no project covers.
 */
export interface SessionGroup {
  key: string
  project: Project | null
  environment: DevEnvironment | null
  entries: SessionEntry[]
}

/**
 * Sessions in an environment missing from `environments` are left out, the way
 * the sidebar leaves out what the environment switch hides.
 */
export function groupSessions(
  sessions: AgentSession[],
  projects: Project[],
  environments: DevEnvironment[]
): SessionGroup[] {
  const byEnvironment = sessionsByEnvironment(sessions)
  const groups: SessionGroup[] = []
  const placed = new Set<string>()

  for (const project of projects) {
    const own: SessionEntry[] = []
    const shared: SessionGroup[] = []
    for (const session of sessions) {
      if (!session.devEnvironmentId && isUnderRepo(session.cwd, project.repoPath) && !placed.has(session.id)) {
        own.push({ session, environment: null })
        placed.add(session.id)
      }
    }
    for (const environment of environments) {
      if (environment.projectId !== project.id) continue
      const inside = byEnvironment.get(environment.id) ?? []
      if (inside.length === 1) {
        own.push({ session: inside[0]!, environment })
      } else if (inside.length) {
        shared.push({
          key: `environment:${environment.id}`,
          project,
          environment,
          entries: inside.map(session => ({ session, environment: null }))
        })
      }
    }
    if (own.length) groups.push({ key: `project:${project.id}`, project, environment: null, entries: own })
    groups.push(...shared)
  }

  const elsewhere = sessions.filter(session => !session.devEnvironmentId && !placed.has(session.id))
  if (elsewhere.length) {
    groups.push({ key: 'other', project: null, environment: null, entries: elsewhere.map(session => ({ session, environment: null })) })
  }
  return groups
}

/** A group's heading: the project, the project and the environment, or the catch-all. */
export function sessionGroupLabel(group: Pick<SessionGroup, 'project' | 'environment'>): string {
  if (!group.project) return 'Other directories'
  return group.environment ? `${group.project.name} › ${group.environment.name}` : group.project.name
}
