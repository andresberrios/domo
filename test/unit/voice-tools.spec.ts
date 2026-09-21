import { beforeEach, describe, expect, it, vi } from 'vitest'

import { agentEvent, textChunk, userMessage } from '../helpers/events'
import type { VoiceToolContext } from '../../server/lib/voice/tools'

/**
 * The voice agent only ever touches Domo through these handlers, and it is a
 * language model: it passes titles with quotes around them, agent names instead
 * of ids, and option ids it made up. Everything below the tools is mocked —
 * spawning a real Claude Code adapter is out of the question in a test.
 */

const repo = {
  createVoiceSession: vi.fn(),
  getAgentSession: vi.fn(),
  getVoiceSession: vi.fn(),
  listAgentEvents: vi.fn(),
  listAgentSessions: vi.fn(),
  listDevEnvironments: vi.fn(),
  listPermissions: vi.fn(),
  listProjects: vi.fn(),
  setAutoTitle: vi.fn(),
  updateAgentSession: vi.fn(),
  updateDevEnvironment: vi.fn(),
  updateProject: vi.fn(),
  updateVoiceSession: vi.fn()
}
const acpManager = {
  answerPermission: vi.fn(),
  cancel: vi.fn(),
  create: vi.fn(),
  promptInBackground: vi.fn(),
  setMode: vi.fn(),
  stop: vi.fn()
}
const devEnvironments = {
  safeEnvironmentName: (name: string) => name,
  createEnvironment: vi.fn(),
  startEnvironment: vi.fn(),
  stopEnvironment: vi.fn()
}
// The export itself is `test/server/git-sync.spec.ts`, against real git; what
// matters here is which environment and which branch the spoken call picks.
const gitSync = {
  exportBranch: vi.fn(),
  listEnvironmentBranches: vi.fn()
}
const projects = {
  createProjectFromPath: vi.fn(),
  removeProjectCascade: vi.fn(),
  removeProjectEnvironment: vi.fn()
}

// The real one spawns an adapter to ask it; that is `adapter-models.spec.ts`.
const catalog = vi.hoisted(() => vi.fn(async (_adapter?: string) => ({
  adapters: [
    { id: 'claude-code', name: 'Claude Code', models: [{ id: 'haiku', name: 'Haiku 4.5' }], default: 'sonnet' },
    { id: 'codex', name: 'Codex', models: [{ id: 'gpt-5.6-luna', name: '5.6 Luna' }], default: 'gpt-5.6-terra' }
  ]
})))

vi.mock('../../server/lib/repo', () => repo)
vi.mock('../../server/lib/acp/models', () => ({ listAdapterCatalog: catalog }))
vi.mock('../../server/lib/acp/manager', () => ({
  acpManager,
  normalizeCwd: (input: string) => input
}))
vi.mock('../../server/lib/dev-environments', () => devEnvironments)
vi.mock('../../server/lib/dev-env/git-sync', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/lib/dev-env/git-sync')>(),
  ...gitSync
}))
vi.mock('../../server/lib/projects', () => projects)
vi.mock('../../server/lib/settings', () => ({
  getSettings: async () => ({ defaultCwd: '/workspace', autoTitle: true })
}))

const { cleanTitle, transcriptDigest, voiceTools, voiceToolDeclarations } = await import(
  '../../server/lib/voice/tools'
)

const handOver = vi.fn()
const ctx: VoiceToolContext = { voiceSessionId: 'vs_1', handOver }

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ag_1',
    title: 'Auth refactor',
    adapter: 'claude-code',
    cwd: '/workspace/api',
    devEnvironmentId: null,
    status: 'idle',
    modeId: 'default',
    lastActivityAt: null,
    summary: null,
    ...overrides
  }
}

function project(overrides: Record<string, unknown> = {}) {
  return { id: 'prj_1', name: 'Domo', repoPath: '/repo/domo', ...overrides }
}

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'env_1',
    projectId: 'prj_1',
    name: 'feature-auth',
    status: 'running',
    workspacePath: '/workspaces/feature-auth',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  repo.listAgentSessions.mockResolvedValue([])
  repo.listPermissions.mockResolvedValue([])
  repo.listProjects.mockResolvedValue([])
  repo.listDevEnvironments.mockResolvedValue([])
})

describe('cleanTitle', () => {
  it('keeps a title that is already plain', () => {
    expect(cleanTitle('Flaky invoice tests')).toBe('Flaky invoice tests')
  })

  it('strips the quotes, markdown and punctuation a spoken model adds', () => {
    expect(cleanTitle('"Auth refactor."')).toBe('Auth refactor')
    expect(cleanTitle('“Auth refactor”')).toBe('Auth refactor')
    expect(cleanTitle('**Auth refactor**')).toBe('Auth refactor')
    expect(cleanTitle('## Auth refactor!')).toBe('Auth refactor')
  })

  it('takes the first line only', () => {
    expect(cleanTitle('Auth refactor\nand some rambling')).toBe('Auth refactor')
  })

  it('truncates a title that would not fit the sidebar', () => {
    const title = cleanTitle('word '.repeat(30))

    expect(title).toHaveLength(60)
    expect(title.endsWith('…')).toBe(true)
  })

  it('is empty for nothing', () => {
    expect(cleanTitle(undefined)).toBe('')
    expect(cleanTitle('   ')).toBe('')
  })
})

describe('set_conversation_title', () => {
  const call = (title: string) => voiceTools.set_conversation_title!.handler({ title }, ctx)

  it('titles a conversation the model still owns', async () => {
    repo.getVoiceSession.mockResolvedValue({ title: 'New conversation', titleSource: 'auto' })
    repo.setAutoTitle.mockResolvedValue({ title: 'Auth refactor' })

    await expect(call('"Auth refactor"')).resolves.toEqual({ applied: true, title: 'Auth refactor' })
    expect(repo.setAutoTitle).toHaveBeenCalledWith('vs_1', 'Auth refactor')
  })

  it('leaves a conversation the user named alone', async () => {
    repo.getVoiceSession.mockResolvedValue({ title: 'Payments', titleSource: 'user' })

    await expect(call('Auth refactor')).resolves.toMatchObject({ applied: false, title: 'Payments' })
    expect(repo.setAutoTitle).not.toHaveBeenCalled()
  })

  it('does not write when the title has not changed', async () => {
    repo.getVoiceSession.mockResolvedValue({ title: 'Auth refactor', titleSource: 'auto' })

    await expect(call('Auth refactor')).resolves.toEqual({ applied: true, title: 'Auth refactor' })
    expect(repo.setAutoTitle).not.toHaveBeenCalled()
  })

  it('accepts a rename that landed while the call was in flight', async () => {
    repo.getVoiceSession.mockResolvedValue({ title: 'New conversation', titleSource: 'auto' })
    // `setAutoTitle` is conditional on the source in SQL: no row means the user won.
    repo.setAutoTitle.mockResolvedValue(null)

    await expect(call('Auth refactor')).resolves.toMatchObject({ applied: false })
  })

  it('refuses an empty title', async () => {
    repo.getVoiceSession.mockResolvedValue({ title: 'New conversation', titleSource: 'auto' })

    await expect(call('  ')).rejects.toThrow('A title is required.')
  })
})

describe('rename_conversation', () => {
  it('takes naming away from the model', async () => {
    await voiceTools.rename_conversation!.handler({ title: '"Payments"' }, ctx)

    expect(repo.updateVoiceSession).toHaveBeenCalledWith('vs_1', { title: 'Payments', titleSource: 'user' })
  })
})

describe('start_new_conversation', () => {
  it('creates a conversation and hands the listener over to it', async () => {
    repo.createVoiceSession.mockResolvedValue({ id: 'vs_2' })

    await expect(voiceTools.start_new_conversation!.handler({}, ctx)).resolves.toEqual({ id: 'vs_2', started: true })
    expect(handOver).toHaveBeenCalledWith('vs_2')
  })
})

describe('resolving which agent the user meant', () => {
  it('falls back to the most recently active one', async () => {
    repo.listAgentSessions.mockResolvedValue([agent({ id: 'ag_recent' }), agent({ id: 'ag_older' })])

    await voiceTools.cancel_agent_turn!.handler({}, ctx)

    expect(acpManager.cancel).toHaveBeenCalledWith('ag_recent')
  })

  it('matches on a partial title, because that is what gets said out loud', async () => {
    repo.listAgentSessions.mockResolvedValue([agent({ id: 'ag_1', title: 'Auth refactor' })])

    await voiceTools.cancel_agent_turn!.handler({ agentId: 'auth' }, ctx)

    expect(acpManager.cancel).toHaveBeenCalledWith('ag_1')
  })

  it('tells the model to list the sessions when nothing matches', async () => {
    repo.listAgentSessions.mockResolvedValue([agent()])

    await expect(voiceTools.cancel_agent_turn!.handler({ agentId: 'billing' }, ctx))
      .rejects.toThrow(/No coding agent matches "billing"\. Call list_agent_sessions first\./)
  })

  it('says so when there are no sessions at all', async () => {
    await expect(voiceTools.cancel_agent_turn!.handler({}, ctx))
      .rejects.toThrow('There are no coding agent sessions yet.')
  })
})

describe('answer_permission', () => {
  const pending = {
    id: 'pm_1',
    agentSessionId: 'ag_1',
    title: 'Run `rm -rf build`',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ]
  }

  it('answers a waiting request as the voice agent', async () => {
    repo.listPermissions.mockResolvedValue([pending])

    await expect(voiceTools.answer_permission!.handler({ permissionId: 'pm_1', optionId: 'allow' }, ctx))
      .resolves.toEqual({ answered: true, optionId: 'allow' })
    expect(acpManager.answerPermission).toHaveBeenCalledWith('ag_1', 'pm_1', 'allow', 'voice-agent')
  })

  it('refuses an option that was not offered, and lists the real ones', async () => {
    repo.listPermissions.mockResolvedValue([pending])

    await expect(voiceTools.answer_permission!.handler({ permissionId: 'pm_1', optionId: 'yes' }, ctx))
      .rejects.toThrow('Option "yes" is not offered. Options: allow, deny')
    expect(acpManager.answerPermission).not.toHaveBeenCalled()
  })

  it('refuses a request that is no longer waiting', async () => {
    await expect(voiceTools.answer_permission!.handler({ permissionId: 'pm_gone', optionId: 'allow' }, ctx))
      .rejects.toThrow('That permission request is no longer waiting.')
  })
})

describe('create_agent_session', () => {
  it('defaults to Claude Code and reports whether it was given work', async () => {
    acpManager.create.mockResolvedValue({ ...agent(), status: 'starting' })

    const result = await voiceTools.create_agent_session!.handler({ title: 'Auth refactor' }, ctx)

    expect(acpManager.create).toHaveBeenCalledWith(expect.objectContaining({
      adapter: 'claude-code',
      title: 'Auth refactor',
      voiceSessionId: 'vs_1'
    }))
    expect(result).toMatchObject({ started: false })
  })

  it('starts Codex when it is asked for, with the first task', async () => {
    acpManager.create.mockResolvedValue({ ...agent({ adapter: 'codex' }), status: 'starting' })

    const result = await voiceTools.create_agent_session!.handler(
      { title: 'Docs', adapter: 'codex', task: 'write the readme' },
      ctx
    )

    expect(acpManager.create).toHaveBeenCalledWith(expect.objectContaining({
      adapter: 'codex',
      initialPrompt: 'write the readme'
    }))
    expect(result).toMatchObject({ started: true })
  })

  it('passes a requested model through, and asks for none when it is omitted', async () => {
    acpManager.create.mockResolvedValue({ ...agent(), status: 'starting' })

    await voiceTools.create_agent_session!.handler({ title: 'Cheap', model: 'haiku' }, ctx)
    expect(acpManager.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }))

    await voiceTools.create_agent_session!.handler({ title: 'Default' }, ctx)
    expect(acpManager.create).toHaveBeenLastCalledWith(expect.objectContaining({ model: undefined }))
  })
})

describe('list_models', () => {
  it('reports every harness and the models it offers', async () => {
    const result = await voiceTools.list_models!.handler({}, ctx) as any

    // The same cached probe the picker uses; the tool adds no second spawn path.
    expect(catalog).toHaveBeenCalledWith(undefined)
    expect(result.adapters[0]).toMatchObject({ id: 'claude-code', name: 'Claude Code' })
  })

  it('filters to one harness, and ignores a name it does not know', async () => {
    await voiceTools.list_models!.handler({ adapter: 'codex' }, ctx)
    expect(catalog).toHaveBeenCalledWith('codex')

    // The model invents ids; an unknown one must not fail the call.
    await voiceTools.list_models!.handler({ adapter: 'gpt-42' }, ctx)
    expect(catalog).toHaveBeenLastCalledWith(undefined)
  })

  it('is declared to the model as the thing to call before picking a model', async () => {
    const declaration = voiceToolDeclarations({ autoTitle: true }).find(entry => entry.name === 'list_models')

    expect(declaration?.description).toMatch(/call this before spawning/i)
    expect(declaration?.parameters?.required ?? []).toEqual([])
  })
})

describe('list_agent_sessions', () => {
  it('counts the permissions each agent is waiting on', async () => {
    repo.listAgentSessions.mockResolvedValue([agent({ id: 'ag_1' }), agent({ id: 'ag_2' })])
    repo.listPermissions.mockResolvedValue([
      { id: 'pm_1', agentSessionId: 'ag_1' },
      { id: 'pm_2', agentSessionId: 'ag_1' }
    ])

    const result = await voiceTools.list_agent_sessions!.handler({}, ctx)

    expect(result.agents.map((item: any) => item.awaitingPermission)).toEqual([2, 0])
  })
})

describe('resolving which project or environment the user meant', () => {
  it('matches a project on a partial name', async () => {
    repo.listProjects.mockResolvedValue([project()])
    projects.removeProjectCascade.mockResolvedValue(undefined)

    await voiceTools.delete_project!.handler({ project: 'domo' }, ctx)

    expect(projects.removeProjectCascade).toHaveBeenCalledWith('prj_1')
  })

  it('tells the model to list projects when nothing matches', async () => {
    repo.listProjects.mockResolvedValue([project()])

    await expect(voiceTools.delete_project!.handler({ project: 'billing' }, ctx))
      .rejects.toThrow(/No project matches "billing"\. Call list_dev_environments first\./)
  })

  it('matches an environment on a partial name', async () => {
    repo.listDevEnvironments.mockResolvedValue([environment()])
    projects.removeProjectEnvironment.mockResolvedValue(undefined)

    await voiceTools.delete_dev_environment!.handler({ environment: 'auth' }, ctx)

    expect(projects.removeProjectEnvironment).toHaveBeenCalledWith('env_1')
  })

  it('tells the model to list environments when nothing matches', async () => {
    repo.listDevEnvironments.mockResolvedValue([environment()])

    await expect(voiceTools.delete_dev_environment!.handler({ environment: 'billing' }, ctx))
      .rejects.toThrow(/No development environment matches "billing"\. Call list_dev_environments first\./)
  })
})

describe('create_project', () => {
  it('creates a project from a repo path', async () => {
    projects.createProjectFromPath.mockResolvedValue(project())

    await expect(voiceTools.create_project!.handler({ repoPath: '/repo/domo' }, ctx))
      .resolves.toEqual({ id: 'prj_1', name: 'Domo', repoPath: '/repo/domo' })
    expect(projects.createProjectFromPath).toHaveBeenCalledWith({ name: undefined, repoPath: '/repo/domo' })
  })
})

describe('update_project', () => {
  it('renames a project the user names by its current name', async () => {
    repo.listProjects.mockResolvedValue([project()])
    repo.updateProject.mockResolvedValue(project({ name: 'Renamed' }))

    await expect(voiceTools.update_project!.handler({ project: 'domo', name: 'Renamed' }, ctx))
      .resolves.toEqual({ id: 'prj_1', name: 'Renamed' })
    expect(repo.updateProject).toHaveBeenCalledWith('prj_1', { name: 'Renamed' })
  })

  it('refuses an empty name', async () => {
    repo.listProjects.mockResolvedValue([project()])

    await expect(voiceTools.update_project!.handler({ project: 'domo', name: '  ' }, ctx))
      .rejects.toThrow('A name is required.')
    expect(repo.updateProject).not.toHaveBeenCalled()
  })
})

describe('delete_project', () => {
  it('removes the project and everything under it', async () => {
    repo.listProjects.mockResolvedValue([project()])

    await expect(voiceTools.delete_project!.handler({ project: 'prj_1' }, ctx))
      .resolves.toEqual({ id: 'prj_1', deleted: true })
    expect(projects.removeProjectCascade).toHaveBeenCalledWith('prj_1')
  })
})

describe('create_dev_environment', () => {
  it('creates an environment for the named project', async () => {
    repo.listProjects.mockResolvedValue([project()])
    devEnvironments.createEnvironment.mockResolvedValue(environment())

    const result = await voiceTools.create_dev_environment!.handler({ project: 'domo', name: 'feature-auth' }, ctx)

    expect(devEnvironments.createEnvironment).toHaveBeenCalledWith({ projectId: 'prj_1', name: 'feature-auth' })
    expect(result).toMatchObject({ id: 'env_1', name: 'feature-auth', status: 'running' })
  })

  it('refuses an empty name', async () => {
    repo.listProjects.mockResolvedValue([project()])

    await expect(voiceTools.create_dev_environment!.handler({ project: 'domo', name: ' ' }, ctx))
      .rejects.toThrow('A name is required.')
    expect(devEnvironments.createEnvironment).not.toHaveBeenCalled()
  })
})

describe('update_dev_environment', () => {
  it('starts the container when asked to run it', async () => {
    repo.listDevEnvironments.mockResolvedValue([environment({ status: 'stopped' })])
    devEnvironments.startEnvironment.mockResolvedValue(environment({ status: 'running' }))

    const result = await voiceTools.update_dev_environment!.handler({ environment: 'auth', status: 'running' }, ctx)

    expect(devEnvironments.startEnvironment).toHaveBeenCalledWith('env_1')
    expect(result).toMatchObject({ status: 'running' })
  })

  it('stops the container when asked to stop it', async () => {
    repo.listDevEnvironments.mockResolvedValue([environment()])
    devEnvironments.stopEnvironment.mockResolvedValue(environment({ status: 'stopped' }))

    const result = await voiceTools.update_dev_environment!.handler({ environment: 'auth', status: 'stopped' }, ctx)

    expect(devEnvironments.stopEnvironment).toHaveBeenCalledWith('env_1')
    expect(result).toMatchObject({ status: 'stopped' })
  })

  it('renames the environment without touching its container', async () => {
    repo.listDevEnvironments.mockResolvedValue([environment()])
    repo.updateDevEnvironment.mockResolvedValue(environment({ name: 'renamed' }))

    const result = await voiceTools.update_dev_environment!.handler({ environment: 'auth', name: 'renamed' }, ctx)

    expect(repo.updateDevEnvironment).toHaveBeenCalledWith('env_1', { name: 'renamed' })
    expect(devEnvironments.startEnvironment).not.toHaveBeenCalled()
    expect(devEnvironments.stopEnvironment).not.toHaveBeenCalled()
    expect(result).toMatchObject({ name: 'renamed' })
  })
})

describe('delete_dev_environment', () => {
  it('removes the environment and its agent sessions', async () => {
    repo.listDevEnvironments.mockResolvedValue([environment()])

    await expect(voiceTools.delete_dev_environment!.handler({ environment: 'env_1' }, ctx))
      .resolves.toEqual({ id: 'env_1', deleted: true })
    expect(projects.removeProjectEnvironment).toHaveBeenCalledWith('env_1')
  })
})

describe('voiceToolDeclarations', () => {
  it('hides the titling tool when auto-titling is off', () => {
    const names = (autoTitle: boolean) => voiceToolDeclarations({ autoTitle }).map(item => item.name)

    expect(names(true)).toContain('set_conversation_title')
    expect(names(false)).not.toContain('set_conversation_title')
    expect(names(false)).toContain('rename_conversation')
  })
})

describe('transcriptDigest', () => {
  it('condenses the event log into something speakable', async () => {
    repo.listAgentEvents.mockResolvedValue([
      userMessage('fix the build'),
      textChunk('Looking '),
      textChunk('at it.'),
      agentEvent('tool_call', { title: 'Bash', status: 'in_progress' }),
      agentEvent('turn_end', { stopReason: 'end_turn' })
    ])

    await expect(transcriptDigest('ag_1')).resolves.toEqual([
      { kind: 'user', text: 'fix the build' },
      { kind: 'agent', text: 'Looking at it.' },
      { kind: 'tool', text: 'Bash (in_progress)' },
      { kind: 'status', text: 'turn finished (end_turn)' }
    ])
  })

  it('keeps only the most recent items', async () => {
    repo.listAgentEvents.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => userMessage(`message ${index}`))
    )

    const items = await transcriptDigest('ag_1', 5)

    expect(items).toHaveLength(5)
    expect(items.at(-1)).toEqual({ kind: 'user', text: 'message 29' })
  })

  it('never reads a wall of text out loud', async () => {
    repo.listAgentEvents.mockResolvedValue([textChunk('x'.repeat(2000))])

    const items = await transcriptDigest('ag_1')

    expect(items[0]!.text).toHaveLength(601)
    expect(items[0]!.text.endsWith('…')).toBe(true)
  })
})

describe('export_branch', () => {
  const exported = {
    ref: 'refs/remotes/domo-env/feature-auth/work',
    sha: 'f00dcafe',
    commits: [{ sha: 'f00dcafe', subject: 'the fix' }],
    into: 'work',
    result: 'fast-forwarded'
  }

  beforeEach(() => {
    repo.listDevEnvironments.mockResolvedValue([environment()])
    gitSync.listEnvironmentBranches.mockResolvedValue({ current: 'work', branches: [] })
    gitSync.exportBranch.mockResolvedValue(exported)
  })

  it('takes the environment by a spoken name and defaults to the branch checked out in it', async () => {
    const result = await voiceTools.export_branch!.handler({ environment: 'auth' }, ctx)

    expect(gitSync.exportBranch).toHaveBeenCalledWith({
      environmentId: 'env_1',
      branch: 'work',
      into: 'work'
    })
    expect(result).toMatchObject({ environment: 'feature-auth', branch: 'work', result: 'fast-forwarded' })
  })

  it('passes a named branch and local branch straight through', async () => {
    await voiceTools.export_branch!.handler({ environment: 'env_1', branch: 'main', into: 'release' }, ctx)

    expect(gitSync.listEnvironmentBranches).not.toHaveBeenCalled()
    expect(gitSync.exportBranch).toHaveBeenCalledWith({
      environmentId: 'env_1',
      branch: 'main',
      into: 'release'
    })
  })

  it('reads an empty local branch as "fetch it, touch nothing"', async () => {
    await voiceTools.export_branch!.handler({ environment: 'auth', branch: 'main', into: '' }, ctx)

    expect(gitSync.exportBranch).toHaveBeenCalledWith(expect.objectContaining({ into: null }))
  })

  it('says so when the environment has nothing checked out', async () => {
    gitSync.listEnvironmentBranches.mockResolvedValue({ current: null, branches: [] })

    await expect(voiceTools.export_branch!.handler({ environment: 'auth' }, ctx))
      .rejects.toThrow(/no branch checked out/)
    expect(gitSync.exportBranch).not.toHaveBeenCalled()
  })

  it('tells the model to list environments when nothing matches', async () => {
    await expect(voiceTools.export_branch!.handler({ environment: 'billing' }, ctx))
      .rejects.toThrow(/No development environment matches "billing"/)
  })
})
