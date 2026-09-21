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

beforeEach(() => {
  vi.clearAllMocks()
  repo.listAgentSessions.mockResolvedValue([])
  repo.listPermissions.mockResolvedValue([])
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
