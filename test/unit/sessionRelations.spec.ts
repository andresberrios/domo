import { describe, expect, it } from 'vitest'

import { folderName, followedSessions, pendingAmong, sessionProject, sessionSettingsSummary, startedSessions } from '~/utils/sessionRelations'
import type { AgentSession, DevEnvironment, PendingPermission, Project } from '~~/shared/types'

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 'ag_1', adapter: 'claude-code', acpSessionId: null, title: 'One', cwd: '/work/domo', devEnvironmentId: null,
    status: 'idle', modeId: null, modes: null, model: null, config: null, configOptions: null, steering: null,
    lastError: null, summary: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null, archived: false, usage: null, spawnedBy: null, assistantId: null,
    ...overrides
  }
}

const project = (id: string, repoPath: string) => ({ id, name: id, repoPath, createdAt: '', updatedAt: '', retiredAt: null }) as Project

describe('sessionProject', () => {
  const projects = [project('outer', '/work/domo'), project('inner', '/work/domo/vendor/lib'), project('other', '/work/other')]

  it('is the environment\'s project for a session in one, whatever its directory says', () => {
    const environment = { id: 'env_1', projectId: 'other' } as DevEnvironment
    expect(sessionProject({ cwd: '/workspaces/domo', devEnvironmentId: 'env_1' }, environment, projects)?.id).toBe('other')
    expect(sessionProject({ cwd: '/work/domo', devEnvironmentId: 'env_1' }, null, projects)).toBeNull()
  })

  it('is the deepest checkout a host session\'s directory is in, and not one that only shares a prefix', () => {
    expect(sessionProject({ cwd: '/work/domo/vendor/lib/src', devEnvironmentId: null }, null, projects)?.id).toBe('inner')
    expect(sessionProject({ cwd: '/work/domo/app', devEnvironmentId: null }, null, projects)?.id).toBe('outer')
    expect(sessionProject({ cwd: '/work/domo-two', devEnvironmentId: null }, null, projects)).toBeNull()
  })
})

describe('who a session works with', () => {
  const sessions = [
    session({ id: 'ag_parent' }),
    session({ id: 'ag_a', spawnedBy: 'ag_parent' }),
    session({ id: 'ag_b', spawnedBy: 'ag_parent' }),
    session({ id: 'ag_peer' }),
    session({ id: 'ag_unrelated', spawnedBy: 'ag_peer' })
  ]

  it('lists the sessions it started', () => {
    expect(startedSessions('ag_parent', sessions).map(item => item.id)).toEqual(['ag_a', 'ag_b'])
    expect(startedSessions('ag_a', sessions)).toEqual([])
  })

  it('lists what it follows, leaving out what it started and what others follow', () => {
    const follows = [
      { subscriberId: 'ag_parent', targetId: 'ag_a' },
      { subscriberId: 'ag_parent', targetId: 'ag_peer' },
      { subscriberId: 'ag_peer', targetId: 'ag_unrelated' }
    ]
    expect(followedSessions('ag_parent', follows, sessions).map(item => item.id)).toEqual(['ag_peer'])
  })

  it('counts only the unanswered requests of the sessions given', () => {
    const pending = [{ agentSessionId: 'ag_a' }, { agentSessionId: 'ag_a' }, { agentSessionId: 'ag_peer' }] as PendingPermission[]
    expect(pendingAmong(startedSessions('ag_parent', sessions), pending)).toBe(2)
  })
})

describe('sessionSettingsSummary', () => {
  it('names each setting by its adapter\'s words, and picks out the effort', () => {
    const summary = sessionSettingsSummary(session({
      model: 'opus',
      modeId: 'plan',
      modes: [{ id: 'plan', name: 'Plan mode' }] as any,
      config: { effort: 'high' },
      configOptions: [
        { id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
        { id: 'fast', name: 'Fast mode', currentValue: 'off', options: [{ value: 'off', name: 'Off' }] }
      ]
    }))
    expect(summary).toEqual({
      model: 'opus',
      mode: 'Plan mode',
      effort: 'High',
      options: [
        { id: 'effort', label: 'Effort', value: 'High', effort: true },
        { id: 'fast', label: 'Fast mode', value: 'Off', effort: false }
      ]
    })
  })

  it('has no effort when the adapter offers none', () => {
    expect(sessionSettingsSummary(session({})).effort).toBeNull()
  })
})

describe('folderName', () => {
  it('is the last segment', () => {
    expect(folderName('/workspaces/domo/')).toBe('domo')
    expect(folderName('/')).toBe('/')
  })
})
