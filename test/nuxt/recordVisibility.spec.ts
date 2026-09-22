import { computed, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The two visibility switches, and the one property that must not regress:
 * **they are independent**.
 *
 * An earlier design coupled them — retiring an environment archived every
 * session inside it, so one switch hid both. That made "why can I not see this"
 * and "why can I not run this" the same question, and it is the coupling this
 * rework removed. A session in a retired environment is visible by default and
 * simply cannot be started; only archiving hides it.
 *
 * The collections are stubbed at the Electric boundary, because what is under
 * test is the deciding that happens above it — the shape itself is deliberately
 * unfiltered, since a row filtered out of a shape cannot be reached at all.
 * The factories below therefore build raw snake_case rows, exactly as Electric
 * hands them over.
 */

const rows = {
  agents: [] as any[],
  environments: [] as any[],
  projects: [] as any[]
}

// The collections are the Electric boundary, and there is none here. Each one
// becomes a marker, and the fake `useLiveQuery` answers with the rows for
// whichever marker the builder asked `from` for.
vi.mock('~/lib/collections', () => ({
  agentSessionsCollection: () => 'agents',
  devEnvironmentsCollection: () => 'environments',
  projectsCollection: () => 'projects',
  agentEventsCollection: () => 'events',
  agentInboxCollection: () => 'inbox',
  cronJobsCollection: () => 'cron',
  mcpServersCollection: () => 'mcp',
  permissionsCollection: () => 'permissions',
  usageLimitsCollection: () => 'usageLimits',
  usageProvidersCollection: () => 'usageProviders',
  voiceMessagesCollection: () => 'voiceMessages',
  voiceSessionsCollection: () => 'voiceSessions'
}))

vi.mock('@tanstack/vue-db', () => ({
  useLiveQuery: (build: (q: any) => any) => {
    let table = ''
    build({ from: (spec: Record<string, string>) => { table = Object.values(spec)[0] ?? ''; return {} } })
    const data = computed(() => rows[table as keyof typeof rows] ?? [])
    return { data, isReady: ref(true) }
  }
}))

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ag_1',
    adapter: 'claude-code',
    title: 'Auth refactor',
    cwd: '/workspaces/domo',
    dev_environment_id: null,
    status: 'idle',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    archived: false,
    ...overrides
  }
}

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'env_1',
    project_id: 'p1',
    name: 'feature-auth',
    container_name: 'domo-dev-env_1',
    workspace_path: '/workspaces/domo',
    status: 'running',
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    retired_at: null,
    ...overrides
  }
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Domo',
    repo_path: '/work/domo',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    retired_at: null,
    ...overrides
  }
}

beforeEach(() => {
  rows.agents = [
    session({ id: 'ag_live' }),
    session({ id: 'ag_archived', archived: true }),
    session({ id: 'ag_stranded', dev_environment_id: 'env_gone' })
  ]
  rows.environments = [environment(), environment({ id: 'env_gone', name: 'spike', retired_at: '2026-01-05T00:00:00.000Z' })]
  rows.projects = [project(), project({ id: 'p_gone', name: 'Old', retired_at: '2026-01-05T00:00:00.000Z' })]
  useShowArchivedSessions().value = false
  useShowRetiredEnvironments().value = false
})

describe('the two visibility switches', () => {
  it('hides archived sessions and retired environments by default', async () => {
    expect(useAgentSessions().sessions.value.map(item => item.id))
      .toEqual(['ag_live', 'ag_stranded'])
    expect(useDevEnvironments().environments.value.map(item => item.id)).toEqual(['env_1'])
    expect(useProjects().projects.value.map(item => item.id)).toEqual(['p1'])
    await nextTick()
  })

  it('keeps a session in a retired environment visible and unarchived', async () => {
    // The whole point of splitting the two concepts: losing a container is not
    // a reason to hide somebody's work. `ag_stranded` is in the default list
    // above, and it is simply not startable.
    const { sessions } = useAgentSessions()
    const stranded = sessions.value.find(item => item.id === 'ag_stranded')!

    expect(stranded.archived).toBe(false)
    expect(useSessionStartability(stranded).value).toMatchObject({ startable: false })
    await nextTick()
  })

  it('does not move one list when the other switch is flipped', async () => {
    useShowRetiredEnvironments().value = true
    await nextTick()

    // Retired environments appear; the archived session stays hidden.
    expect(useDevEnvironments().environments.value.map(item => item.id)).toEqual(['env_1', 'env_gone'])
    expect(useAgentSessions().sessions.value.map(item => item.id)).toEqual(['ag_live', 'ag_stranded'])

    useShowRetiredEnvironments().value = false
    useShowArchivedSessions().value = true
    await nextTick()

    expect(useAgentSessions().sessions.value.map(item => item.id))
      .toEqual(['ag_live', 'ag_archived', 'ag_stranded'])
    expect(useDevEnvironments().environments.value.map(item => item.id)).toEqual(['env_1'])
  })

  it('still finds a retired environment through `all`, whatever the switch says', async () => {
    // The agent page and every "where did this run" badge read `all`: a record
    // that is unreachable because a switch is off is not a record.
    expect(useDevEnvironments().all.value.map(item => item.id)).toEqual(['env_1', 'env_gone'])
    expect(useProjects().all.value.map(item => item.id)).toEqual(['p1', 'p_gone'])
    await nextTick()
  })
})
