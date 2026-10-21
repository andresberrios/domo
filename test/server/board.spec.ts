import { beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import {
  createAgentSession,
  createAssistantRow,
  createDevEnvironmentRow,
  createProject,
  deleteAgentSession,
  getBoard,
  listBoardDrafts,
  markBoardSeen,
  retireDevEnvironmentRow,
  setBoardDraft,
  updateAssistant
} from '../../server/lib/repo'
import { boardOwnerFor, submitBoard } from '../../server/lib/board'
import { handleMeshMcpRequest } from '../../server/lib/mesh/server'
import { mintMeshToken } from '../../server/lib/mesh/token'

/**
 * The board against the real Postgres: the mesh tools an agent edits it with,
 * the drafts the human leaves on it, and the submit that turns them into one
 * message. Only the adapter manager is faked; a real one would start an agent.
 */

const acp = vi.hoisted(() => ({
  deliver: vi.fn(async (id: string, input: any) => ({
    delivery: input.delivery,
    outcome: 'queued',
    agentSessionId: id
  })),
  drainInbox: vi.fn(),
  wake: vi.fn(),
  isBusy: vi.fn(() => false)
}))
vi.mock('../../server/lib/acp/manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/lib/acp/manager')>()
  return { ...original, acpManager: acp }
})

let nextId = 1
async function tool(sessionId: string, name: string, args: unknown = {}) {
  const response = await handleMeshMcpRequest(new Request('http://mesh.internal/api/internal/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      'authorization': `Bearer ${mintMeshToken(sessionId)}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })
  }))
  const body = await response.json()
  const text = body.result.content[0].text as string
  return { isError: !!body.result.isError, text, json: body.result.isError ? null : JSON.parse(text) }
}

const session = (title: string, patch: Record<string, unknown> = {}) =>
  createAgentSession({ adapter: 'claude-code', title, cwd: '/tmp/domo-board', ...patch })

async function assistantWithSession() {
  const assistant = await createAssistantRow({
    name: 'Ada', avatar: null, persona: '', adapter: 'claude-code', model: null, modeId: null,
    cwd: '/tmp/domo-board', devEnvironmentId: null, handoffThreshold: null
  })
  const first = await session('Ada', { assistantId: assistant.id })
  await updateAssistant(assistant.id, { currentSessionId: first.id })
  return { assistant, first }
}

const BOARD = [
  { op: 'put', id: 'db', kind: 'question', title: 'Which database?', options: [{ id: 'pg', label: 'Postgres' }, { id: 'sqlite', label: 'SQLite' }] },
  { op: 'put', id: 'plan', kind: 'checklist', title: 'Plan', group: 'Work', items: [{ id: 'schema', text: 'Schema', status: 'done' }, { id: 'tests', text: 'Tests' }] },
  { op: 'put', id: 'zod', kind: 'decision', title: 'Validate with zod', group: 'Work' }
]

beforeEach(async () => {
  await query('truncate agent_sessions, assistants, projects, boards, board_elements, board_drafts cascade')
  acp.deliver.mockClear()
})

describe('the board tools', () => {
  it('lists both tools and tells every agent about the board', async () => {
    const agent = await session('worker')
    const response = await handleMeshMcpRequest(new Request('http://mesh.internal/api/internal/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': `Bearer ${mintMeshToken(agent.id)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
    }))
    expect((await response.json()).result.instructions).toMatch(/status board.*update_board/)
  })

  it('edits surgically, writes only the rows it changed, and reads back compactly', async () => {
    const agent = await session('worker')
    const written = await tool(agent.id, 'update_board', { ops: [{ op: 'headline', text: 'Setting up' }, ...BOARD] })
    expect(written.json).toEqual({ ok: true, elements: 3, groups: ['Work'], openQuestions: ['db'] })

    const before = await query('select id, updated_at from board_elements order by id')
    await new Promise(resolve => setTimeout(resolve, 5))
    await tool(agent.id, 'update_board', { ops: [{ op: 'items', id: 'plan', set: [{ id: 'tests', status: 'ongoing' }] }] })
    const after = await query('select id, updated_at from board_elements order by id')
    const moved = after.filter((row, index) => row.updated_at !== before[index].updated_at).map(row => row.id)
    expect(moved).toEqual(['plan'])

    const read = await tool(agent.id, 'read_board')
    expect(read.json.headline).toBe('Setting up')
    expect(read.json.elements.map((element: any) => element.id)).toEqual(['db', 'plan', 'zod'])
    expect(read.json.elements[1].items[1]).toEqual({ id: 'tests', text: 'Tests', status: 'ongoing' })
    const board = await getBoard(agent.id)
    expect(board.agentChangedAt).not.toBeNull()
  })

  it('rejects a bad batch whole, naming the op', async () => {
    const agent = await session('worker')
    await tool(agent.id, 'update_board', { ops: BOARD })
    const refused = await tool(agent.id, 'update_board', { ops: [{ op: 'remove', id: 'db' }, { op: 'items', id: 'zod', set: [{ id: 'x' }] }] })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/ops\[1\] \(items zod\): "zod" is a decision/)
    expect((await getBoard(agent.id)).elements).toHaveLength(3)
  })

  it('reads another agent\'s board by id', async () => {
    const worker = await session('worker')
    const boss = await session('boss')
    await tool(worker.id, 'update_board', { ops: BOARD })
    expect((await tool(boss.id, 'read_board', { agentId: worker.id })).json.elements).toHaveLength(3)
    expect((await tool(boss.id, 'read_board')).json.elements).toEqual([])
  })

  it('gives an assistant one board across its sessions', async () => {
    const { assistant, first } = await assistantWithSession()
    await tool(first.id, 'update_board', { ops: BOARD })
    const second = await session('Ada', { assistantId: assistant.id })
    await updateAssistant(assistant.id, { currentSessionId: second.id })
    expect(await boardOwnerFor(second.id)).toBe(assistant.id)
    const read = await tool(second.id, 'read_board')
    expect(read.json.elements.map((element: any) => element.id)).toEqual(['db', 'plan', 'zod'])
    expect((await getBoard(first.id)).elements).toEqual([])
  })
})

describe('who writes a board', () => {
  it('is its owner alone; anyone may read it', async () => {
    const coordinator = await session('Coordinator')
    const worker = await session('Worker', { spawnedBy: coordinator.id })
    await tool(coordinator.id, 'update_board', { ops: BOARD })
    // The tool takes no target: whatever a worker writes lands on its own board.
    const refused = await tool(worker.id, 'update_board', { board: coordinator.id, ops: [{ op: 'remove', id: 'db' }] })
    expect(refused.isError).toBe(true)
    expect((await getBoard(coordinator.id)).elements).toHaveLength(3)
    expect((await tool(worker.id, 'read_board', { agentId: coordinator.id })).json.elements).toHaveLength(3)
  })
})

describe('submitting the human\'s drafts', () => {
  it('records them, clears them and sends one queued message', async () => {
    const agent = await session('worker')
    await tool(agent.id, 'update_board', { ops: BOARD })
    await setBoardDraft(agent.id, 'db', { answer: { options: ['pg'] } })
    await setBoardDraft(agent.id, 'plan', { acknowledgeItems: ['schema'], reply: 'Skip the down migration.' })
    await setBoardDraft(agent.id, 'zod', { acknowledge: true })

    expect(await submitBoard(agent.id)).toEqual({ submitted: 3, outcome: 'queued' })
    expect(acp.deliver).toHaveBeenCalledTimes(1)
    const [target, input] = acp.deliver.mock.calls[0]!
    expect(target).toBe(agent.id)
    expect(input.delivery).toBe('queue')
    expect(input.origin).toBe('user')
    expect(input.content[0].text).toContain('- Question "Which database?" [db]: answered "Postgres" [pg]')
    expect(input.content[0].text).toContain('- Checklist "Plan" [plan]: acknowledged done "Schema" [schema]; replied:\n    Skip the down migration.')

    expect((await listBoardDrafts(agent.id)).size).toBe(0)
    const board = await getBoard(agent.id)
    const byId = new Map(board.elements.map(element => [element.id, element]))
    expect(byId.get('db')!.response.answer?.options).toEqual(['pg'])
    expect(byId.get('zod')!.response.acknowledgedAt).toBeTruthy()
    expect(byId.get('plan')!.thread.map(entry => entry.from)).toEqual(['user'])
    // The human's own submit is not news to the human.
    expect(board.agentChangedAt! < byId.get('db')!.updatedAt).toBe(true)

    // The agent sees what the human did.
    const read = await tool(agent.id, 'read_board')
    expect(read.json.elements[0].answer).toEqual({ options: ['pg'] })
    expect(read.json.elements[1].thread).toEqual(['user: Skip the down migration.'])
  })

  it('goes to the assistant\'s current session', async () => {
    const { assistant, first } = await assistantWithSession()
    await tool(first.id, 'update_board', { ops: BOARD })
    await setBoardDraft(assistant.id, 'db', { answer: { options: [], text: 'Whichever is simpler' } })
    await submitBoard(assistant.id)
    expect(acp.deliver.mock.calls[0]![0]).toBe(first.id)
    expect(acp.deliver.mock.calls[0]![1].content[0].text).toContain('answered in their own words:\n    Whichever is simpler')
  })

  it('sends nothing when nothing is left to send, and drops drafts on removed elements', async () => {
    const agent = await session('worker')
    await tool(agent.id, 'update_board', { ops: BOARD })
    await setBoardDraft(agent.id, 'zod', { acknowledge: true })
    await tool(agent.id, 'update_board', { ops: [{ op: 'remove', id: 'zod' }] })
    expect((await listBoardDrafts(agent.id)).size).toBe(0)
    await setBoardDraft(agent.id, 'db', { answer: { options: ['mysql'] } })
    expect(await submitBoard(agent.id)).toEqual({ submitted: 0 })
    expect(acp.deliver).not.toHaveBeenCalled()
    expect((await listBoardDrafts(agent.id)).size).toBe(0)
  })

  it('refuses a session that can no longer run, and leaves the board as it was', async () => {
    const project = await createProject({ name: 'p', repoPath: '/tmp/domo-board' })
    const environment = await createDevEnvironmentRow({ projectId: project.id, name: 'gone', containerName: 'domo-gone', workspacePath: '/workspaces/gone' })
    const agent = await session('worker', { devEnvironmentId: environment.id })
    await tool(agent.id, 'update_board', { ops: BOARD })
    await retireDevEnvironmentRow(environment.id)
    await setBoardDraft(agent.id, 'zod', { acknowledge: true })
    await expect(submitBoard(agent.id)).rejects.toThrow(/can no longer be started/)
    expect((await getBoard(agent.id)).elements.find(element => element.id === 'zod')!.response).toEqual({})
    // Kept, like its transcript.
    expect((await getBoard(agent.id)).elements).toHaveLength(3)
  })
})

describe('the board\'s lifetime', () => {
  it('marks seen forward only, and goes with a purged session', async () => {
    const agent = await session('worker')
    await tool(agent.id, 'update_board', { ops: BOARD })
    await markBoardSeen(agent.id, '2999-01-01T00:00:00.000Z')
    await markBoardSeen(agent.id, '2000-01-01T00:00:00.000Z')
    expect((await getBoard(agent.id)).seenAt).toBe('2999-01-01T00:00:00.000Z')
    await setBoardDraft(agent.id, 'db', { dismiss: true })
    await deleteAgentSession(agent.id)
    const left = await query('select (select count(*) from boards) + (select count(*) from board_elements) + (select count(*) from board_drafts) as n')
    expect(Number(left[0].n)).toBe(0)
  })
})
