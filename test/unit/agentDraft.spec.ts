import { describe, expect, it } from 'vitest'

import {
  agentPageKey,
  draftRequest,
  freshDraftPage,
  initialDraft,
  newAgentPath,
  promoteDraftPage
} from '~/utils/agentDraft'
import { talkAssistant } from '~/utils/talk'
import type { AgentSession, Assistant, DevEnvironment, Project } from '~~/shared/types'

const project = (id: string, repoPath: string) => ({ id, name: id, repoPath }) as Project
const environment = (id: string, projectId: string, status: DevEnvironment['status']) =>
  ({ id, projectId, name: id, status }) as DevEnvironment

const projects = [project('p1', '/work/one'), project('p2', '/work/two')]

describe('the draft a new-session page opens with', () => {
  it('takes the environment named in the address, and the project with it', () => {
    const draft = initialDraft({ environment: 'env_b' }, projects, [environment('env_a', 'p1', 'running'), environment('env_b', 'p2', 'stopped')], '/home')
    expect(draft).toMatchObject({ projectId: 'p2', devEnvironmentId: 'env_b', adapter: 'claude-code', model: '', modeId: '' })
  })

  it('runs a named project in its own checkout, even with an environment running', () => {
    const draft = initialDraft({ project: 'p2' }, projects, [environment('env_a', 'p2', 'running')], '/home')
    expect(draft).toMatchObject({ projectId: 'p2', devEnvironmentId: null, cwd: '/work/two' })
  })

  it('reads project=none as a choice: no project, the default directory', () => {
    const draft = initialDraft({ project: 'none' }, projects, [environment('env_a', 'p1', 'running')], '/home')
    expect(draft).toMatchObject({ projectId: null, devEnvironmentId: null, cwd: '/home' })
  })

  it('with no target, prefers a running environment, then the first project', () => {
    expect(initialDraft({}, projects, [environment('env_a', 'p2', 'stopped'), environment('env_c', 'p2', 'running')], '/home'))
      .toMatchObject({ projectId: 'p2', devEnvironmentId: 'env_c' })
    expect(initialDraft({}, projects, [], '/home')).toMatchObject({ projectId: 'p1', devEnvironmentId: null, cwd: '/work/one' })
    expect(initialDraft({ project: 'gone' }, [], [], '/home')).toMatchObject({ projectId: null, cwd: '/home' })
  })
})

describe('the request a draft becomes', () => {
  const base = initialDraft({ project: 'p1' }, projects, [], '/home')
  const message = [{ type: 'text', text: 'go' }]

  it('leaves every default to the server rather than naming it', () => {
    expect(draftRequest(base, message)).toEqual({
      title: undefined,
      adapter: 'claude-code',
      cwd: '/work/one',
      devEnvironmentId: undefined,
      model: undefined,
      modeId: undefined,
      config: undefined,
      firstMessage: message
    })
  })

  it('sends no directory for an environment, whose workspace is its own', () => {
    const body = draftRequest({ ...base, devEnvironmentId: 'env_a', model: 'haiku', modeId: 'plan', config: { effort: 'high' }, title: ' Auth ' }, message)
    expect(body).toMatchObject({ devEnvironmentId: 'env_a', cwd: undefined, model: 'haiku', modeId: 'plan', config: { effort: 'high' }, title: 'Auth' })
  })
})

describe('the agent page key', () => {
  it('keeps the draft\'s key for the session it became, and only for that one', () => {
    freshDraftPage()
    const draft = agentPageKey({ params: { id: 'new' } })
    promoteDraftPage('ag_1')
    expect(agentPageKey({ params: { id: 'ag_1' } })).toBe(draft)
    expect(agentPageKey({ params: { id: 'ag_2' } })).toBe('agent-ag_2')
  })

  it('gives every new visit to the draft page a page of its own', () => {
    freshDraftPage()
    const before = agentPageKey({ params: { id: 'new' } })
    promoteDraftPage('ag_1')
    freshDraftPage()
    expect(agentPageKey({ params: { id: 'new' } })).not.toBe(before)
    expect(agentPageKey({ params: { id: 'ag_1' } })).toBe('agent-ag_1')
  })
})

describe('newAgentPath', () => {
  it('names an environment, a project, or no project at all', () => {
    expect(newAgentPath()).toBe('/agents/new')
    expect(newAgentPath({ environmentId: 'env_1', projectId: 'p1' })).toBe('/agents/new?environment=env_1')
    expect(newAgentPath({ projectId: 'p1' })).toBe('/agents/new?project=p1')
    expect(newAgentPath({ projectId: null })).toBe('/agents/new?project=none')
  })
})

describe('the assistant Talk opens', () => {
  const assistant = (id: string, currentSessionId: string | null, extra: Partial<Assistant> = {}) =>
    ({ id, name: id, currentSessionId, archived: false, updatedAt: '2026-01-01T00:00:00.000Z', ...extra }) as Assistant
  const session = (id: string, lastActivityAt: string | null) =>
    ({ id, lastActivityAt, createdAt: '2026-01-01T00:00:00.000Z' }) as AgentSession

  const sessions = [session('ag_a', '2026-03-01T00:00:00.000Z'), session('ag_b', '2026-05-01T00:00:00.000Z')]
  const both = [assistant('as_a', 'ag_a'), assistant('as_b', 'ag_b')]

  it('is the one Settings names', () => {
    expect(talkAssistant(both, sessions, 'as_a')?.id).toBe('as_a')
  })

  it('is otherwise the one talked to most recently', () => {
    expect(talkAssistant(both, sessions, '')?.id).toBe('as_b')
    expect(talkAssistant(both, sessions, 'as_deleted')?.id).toBe('as_b')
  })

  it('is never an archived one, named or not', () => {
    const archived = [assistant('as_a', 'ag_a'), assistant('as_b', 'ag_b', { archived: true })]
    expect(talkAssistant(archived, sessions, 'as_b')?.id).toBe('as_a')
    expect(talkAssistant([assistant('as_b', 'ag_b', { archived: true })], sessions, '')).toBeNull()
  })

  it('is none when there are no assistants', () => {
    expect(talkAssistant([], sessions, 'as_a')).toBeNull()
  })
})
