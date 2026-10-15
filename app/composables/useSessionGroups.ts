import type { AgentSession } from '~~/shared/types'

/**
 * Sessions grouped as the sidebar groups them (`groupSessions`), from the live
 * rows.
 *
 * `listed` is what a page lists: the same sessions, environments and projects
 * the sidebar shows under its "show archived" and "show retired" switches.
 * `offered` is what a picker offers as a target, whatever the switches say:
 * nothing archived and nothing that can no longer run.
 */
export function useSessionGroups(mode: 'listed' | 'offered' = 'listed') {
  const { sessions: visible, all } = useAgentSessions()
  const { environments: visibleEnvironments, all: allEnvironments } = useDevEnvironments()
  const { projects: visibleProjects, all: allProjects } = useProjects()

  const candidates = computed<AgentSession[]>(() => mode === 'offered'
    ? offerableSessions(all.value, allEnvironments.value)
    : visible.value.filter(session => !session.assistantId))

  const groups = computed(() => mode === 'offered'
    ? groupSessions(candidates.value, allProjects.value.filter(project => !project.retiredAt), allEnvironments.value.filter(environment => !environment.retiredAt))
    : groupSessions(candidates.value, visibleProjects.value, visibleEnvironments.value))

  /** Exactly what the groups hold, in their order. */
  const sessions = computed(() => groups.value.flatMap(group => group.entries.map(entry => entry.session)))

  return { sessions, groups, all }
}
