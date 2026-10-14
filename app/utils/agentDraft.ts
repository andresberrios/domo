import type { AgentDraft, DevEnvironment, Project } from '~~/shared/types'

/**
 * Where to start a new session, as the page that offers it knows it. The draft
 * page reads these back; `project=none` asks for an arbitrary directory.
 */
export function newAgentPath(target: { projectId?: string | null, environmentId?: string | null } = {}): string {
  if (target.environmentId) return `/agents/new?environment=${encodeURIComponent(target.environmentId)}`
  if (target.projectId === null) return '/agents/new?project=none'
  if (target.projectId) return `/agents/new?project=${encodeURIComponent(target.projectId)}`
  return '/agents/new'
}

/** The project's own checkout is where a host session in it belongs by default. */
export function defaultDraftCwd(projects: Project[], projectId: string | null, defaultCwd: string | undefined): string {
  return projects.find(project => project.id === projectId)?.repoPath ?? defaultCwd ?? ''
}

/**
 * A fresh draft for the place the new-session page was opened from.
 *
 * An environment named in the address wins, and it decides the project too.
 * A project runs in its own checkout. `project=none` is a choice — an
 * arbitrary directory — while no target at all leaves it to this: any running
 * environment, then the first project's checkout, then the default directory.
 */
export function initialDraft(
  query: { project?: string | null, environment?: string | null },
  projects: Project[],
  environments: DevEnvironment[],
  defaultCwd: string | undefined
): AgentDraft {
  const target = initialTarget(query, projects, environments)
  return {
    adapter: 'claude-code',
    model: '',
    modeId: '',
    config: {},
    ...target,
    cwd: defaultDraftCwd(projects, target.projectId, defaultCwd),
    title: ''
  }
}

function initialTarget(
  query: { project?: string | null, environment?: string | null },
  projects: Project[],
  environments: DevEnvironment[]
): { projectId: string | null, devEnvironmentId: string | null } {
  const named = query.environment ? environments.find(environment => environment.id === query.environment) : null
  if (named) return { projectId: named.projectId, devEnvironmentId: named.id }
  if (query.project === 'none') return { projectId: null, devEnvironmentId: null }
  if (query.project && projects.some(project => project.id === query.project)) {
    return { projectId: query.project, devEnvironmentId: null }
  }
  const running = environments.find(environment => environment.status === 'running')
  if (running) return { projectId: running.projectId, devEnvironmentId: running.id }
  return { projectId: projects[0]?.id ?? null, devEnvironmentId: null }
}

/** The body of `POST /api/agents` for a draft and its first message. */
export function draftRequest(draft: AgentDraft, firstMessage: any[]) {
  const local = !draft.devEnvironmentId
  return {
    title: draft.title.trim() || undefined,
    adapter: draft.adapter,
    // An environment's own workspace is the directory when there is one, so
    // the path only means anything for a session on the host.
    cwd: local ? (draft.cwd.trim() || undefined) : undefined,
    devEnvironmentId: draft.devEnvironmentId ?? undefined,
    model: draft.model || undefined,
    modeId: draft.modeId || undefined,
    config: Object.keys(draft.config).length ? draft.config : undefined,
    firstMessage
  }
}

/**
 * The agent page's key, which is what makes a draft turn into its session
 * without a remount.
 *
 * Nuxt keys a page by its path, so the move from `/agents/new` to
 * `/agents/ag_…` would build the page again — composer, transcript, scroll and
 * all — at the moment it has to look continuous. The session a draft became
 * keeps the draft's key instead; every other session keys by its id, as by
 * default. Each visit to `/agents/new` is a fresh draft, so it is a new key.
 */
const draftPage = { serial: 0, promoted: null as string | null }

export function agentPageKey(route: { params: Record<string, unknown> }): string {
  const id = String(route.params.id)
  if (id === 'new' || id === draftPage.promoted) return `agent-draft-${draftPage.serial}`
  return `agent-${id}`
}

/** A visit to `/agents/new`: a page of its own. */
export function freshDraftPage(): void {
  draftPage.serial += 1
  draftPage.promoted = null
}

/** The draft became this session; its page stays the one that is open. */
export function promoteDraftPage(agentSessionId: string): void {
  draftPage.promoted = agentSessionId
}
