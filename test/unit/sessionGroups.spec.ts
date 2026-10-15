import { describe, expect, it } from 'vitest'

import { groupSessions, offerableSessions, sessionGroupLabel } from '~/utils/sessionGroups'
import type { AgentSession, DevEnvironment, Project } from '~~/shared/types'

const project = (id: string, repoPath: string) => ({ id, name: id, repoPath, retiredAt: null }) as Project
const environment = (id: string, projectId: string, retiredAt: string | null = null) =>
  ({ id, projectId, name: id, retiredAt, status: 'running' }) as DevEnvironment
const session = (id: string, place: { env?: string, cwd?: string }, extra: Partial<AgentSession> = {}) =>
  ({ id, title: id, devEnvironmentId: place.env ?? null, cwd: place.cwd ?? '/workspace/repo', archived: false, assistantId: null, ...extra }) as AgentSession

const projects = [project('domo', '/work/domo'), project('web', '/work/web')]
const environments = [
  environment('solo', 'domo'),
  environment('pair', 'domo'),
  environment('empty', 'domo'),
  environment('site', 'web')
]

describe('groupSessions', () => {
  it('groups by project, folds a one-session environment into its session, and gives a shared one its own group', () => {
    const groups = groupSessions([
      session('host', { cwd: '/work/domo/sub' }),
      session('only', { env: 'solo' }),
      session('first', { env: 'pair' }),
      session('second', { env: 'pair' }),
      session('landing', { env: 'site' }),
      session('scratch', { cwd: '/tmp/scratch' })
    ], projects, environments)

    expect(groups.map(group => [sessionGroupLabel(group), group.entries.map(entry => [entry.session.id, entry.environment?.id ?? null])])).toEqual([
      ['domo', [['host', null], ['only', 'solo']]],
      ['domo › pair', [['first', null], ['second', null]]],
      ['web', [['landing', 'site']]],
      ['Other directories', [['scratch', null]]]
    ])
  })

  it('does not take /work/domo-other for /work/domo', () => {
    const groups = groupSessions([session('neighbour', { cwd: '/work/domo-other' })], projects, environments)
    expect(groups.map(sessionGroupLabel)).toEqual(['Other directories'])
  })

  it('leaves out a session whose environment is not in the list, as the sidebar does', () => {
    expect(groupSessions([session('hidden', { env: 'gone' })], projects, environments)).toEqual([])
  })
})

describe('offerableSessions', () => {
  it('offers nothing archived, nothing of an assistant, and nothing that can no longer run', () => {
    const all = [...environments, environment('retired', 'domo', '2026-10-01T00:00:00.000Z')]
    const offered = offerableSessions([
      session('live', { env: 'solo' }),
      session('host', { cwd: '/work/domo' }),
      session('archived', { env: 'solo' }, { archived: true }),
      session('assistant', { cwd: '/work/domo' }, { assistantId: 'as_1' }),
      session('retired', { env: 'retired' }),
      session('vanished', { env: 'missing' })
    ], all)
    expect(offered.map(item => item.id)).toEqual(['live', 'host'])
  })
})
