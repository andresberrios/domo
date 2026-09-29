import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import {
  addAgentSubscription,
  appendAgentEvent,
  createAgentSession,
  createDevEnvironmentRow,
  createPermission,
  createProject,
  deleteAgentSession,
  enqueueInboxMessage,
  getCronJob,
  getNotification,
  listAgentEvents,
  listAgentSubscriptions,
  listCronJobs,
  listCronRuns,
  listInboxMessages,
  setAgentUsage,
  updateAgentSession,
  updateDevEnvironment
} from '../../server/lib/repo'
import { attachmentPath } from '../../server/lib/notifications'
import { startSubscriptionNotifier, stopSubscriptionNotifier } from '../../server/lib/acp/subscriptions'
import { pinnedAdapterVersions } from '../../server/lib/dev-env/runtime-volume'
import { handleMeshMcpRequest } from '../../server/lib/mesh/server'
import { mintMeshToken } from '../../server/lib/mesh/token'

/**
 * The mesh endpoint is the whole surface a coding agent has on the rest of
 * Domo, and its only authentication is the bearer token. Everything below runs
 * against the real Postgres — only the ACP manager and the Docker-backed
 * environment lifecycle are faked, because a real one would spawn an adapter
 * or a container.
 */

const acp = vi.hoisted(() => ({
  promptInBackground: vi.fn(async () => {}),
  drainInbox: vi.fn(),
  stop: vi.fn(),
  isBusy: vi.fn(() => false),
  cancel: vi.fn(async () => {}),
  answerPermission: vi.fn(async () => true),
  deliver: vi.fn(async (_id: string, input: any) => ({
    delivery: input.delivery,
    outcome: input.delivery === 'queue' ? 'queued' : 'prompted'
  })),
  // The implementation is set in `beforeEach`: it has to insert a real row, or
  // a subscription to the spawned peer has nothing to reference.
  create: vi.fn()
}))

vi.mock('../../server/lib/acp/manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/lib/acp/manager')>()
  return { ...original, acpManager: acp }
})

// `built` is what the background build settles to; a test that cares replaces
// it before calling, to see what the caller is told either way.
const building = vi.hoisted(() => ({ built: null as Promise<any> | null }))

const devEnvironments = vi.hoisted(() => ({
  safeEnvironmentName: (name: string) => name,
  beginEnvironment: vi.fn(async (input: any) => {
    const environment = {
      id: 'env_new',
      projectId: input.projectId,
      name: input.name,
      status: 'creating',
      workspacePath: '/workspaces/env_new'
    }
    const built = building.built ?? Promise.resolve({
      ...environment,
      status: 'running',
      workspaceSeed: { paths: [], total: 0, copied: [], install: null, branch: { name: input.name, created: true } }
    })
    return { environment, built }
  }),
  environmentAdapterVersions: vi.fn(async (environment: any) => environment.adapterVersions ?? null),
  startEnvironment: vi.fn(async (id: string) => ({ id, name: 'env', status: 'running' })),
  stopEnvironment: vi.fn(async (id: string) => ({ id, name: 'env', status: 'stopped' })),
  // What a cleanup with a working daemon reports: nothing left over.
  retireEnvironment: vi.fn(async () => ({ removed: [], leftovers: [], unattributed: [], branches: [] as any[] })),
  cleanupEnvironment: vi.fn(async (): Promise<{
    removed: Array<{ kind: string, name: string, environmentId: string }>
    leftovers: Array<{ kind: string, name: string, environmentId: string, error: string }>
    unattributed: string[]
    branches: any[]
  }> => ({ removed: [], leftovers: [], unattributed: [], branches: [] }))
}))

vi.mock('../../server/lib/dev-environments', () => devEnvironments)

// No Docker here: an environment row with no container behind it, as far as
// the mesh can tell.
const docker = vi.hoisted(() => ({ inspectContainer: vi.fn(async (): Promise<any> => null) }))
vi.mock('../../server/lib/dev-env/docker', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/lib/dev-env/docker')>(),
  ...docker
}))

const ports = vi.hoisted(() => ({
  refreshEnvironmentPorts: vi.fn(async () => [] as any[]),
  forwardEnvironmentPort: vi.fn(async (_id: string, port: number) => ({ innerPort: port, url: 'http://127.0.0.1:49152' })),
  unforwardEnvironmentPort: vi.fn(async () => {})
}))
vi.mock('../../server/lib/dev-environment-ports', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/lib/dev-environment-ports')>(),
  ...ports
}))
// The real one spawns an adapter to ask it; that belongs to `adapter-models.spec.ts`.
const catalog = vi.hoisted(() => vi.fn(async (_adapter?: string) => ({
  adapters: [
    { id: 'claude-code', name: 'Claude Code', models: [{ id: 'haiku', name: 'Haiku 4.5' }], default: 'sonnet' },
    { id: 'codex', name: 'Codex', models: [{ id: 'gpt-5.6-luna', name: '5.6 Luna' }], default: 'gpt-5.6-terra' }
  ]
})))

vi.mock('../../server/lib/acp/models', () => ({ listAdapterCatalog: catalog }))

let nextId = 1

async function call(token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream'
  }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await handleMeshMcpRequest(
    new Request('http://mesh.internal/api/internal/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
    })
  )
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const callTool = (token: string, name: string, args: unknown = {}) =>
  call(token, 'tools/call', { name, arguments: args })

/** The JSON a mesh tool answered with, parsed back out of its text content. */
const resultOf = (body: any) => JSON.parse(body.result.content[0].text)

async function session(title: string, patch: Record<string, unknown> = {}) {
  return createAgentSession({ adapter: 'claude-code', title, cwd: '/tmp/domo-mesh', ...patch })
}

async function runningEnvironment(name: string) {
  const project = await createProject({ name: `${name}-project`, repoPath: '/tmp/domo-mesh' })
  const environment = await createDevEnvironmentRow({
    projectId: project.id,
    name,
    containerName: `domo-${name}`,
    workspacePath: `/workspaces/${name}`
  })
  await query(`update dev_environments set status = 'running' where id = $1`, [environment.id])
  return { ...environment, status: 'running' as const }
}

beforeEach(async () => {
  await query('truncate agent_sessions, projects cascade')
  acp.promptInBackground.mockClear()
  acp.deliver.mockClear()
  acp.create.mockClear()
  acp.cancel.mockClear()
  acp.answerPermission.mockClear()
  acp.isBusy.mockReset().mockReturnValue(false)
  building.built = null
  devEnvironments.beginEnvironment.mockClear()
  // The real one writes an `agent_sessions` row; anything that then points at
  // the new session — a subscription — needs that row to exist.
  acp.create.mockImplementation(async (input: any) => createAgentSession({
    adapter: input.adapter,
    title: input.title,
    cwd: input.cwd ?? '/workspace',
    devEnvironmentId: input.devEnvironmentId ?? null,
    model: input.model ?? null,
    modeId: input.modeId ?? null,
    spawnedBy: input.spawnedBy ?? null
  }))
  devEnvironments.startEnvironment.mockClear()
  devEnvironments.stopEnvironment.mockClear()
  devEnvironments.retireEnvironment.mockClear()
  devEnvironments.cleanupEnvironment.mockClear()
})

describe('the agent-mesh MCP endpoint', () => {
  it('refuses a request with no token and one with a forged token', async () => {
    await expect(call(null, 'tools/list')).resolves.toMatchObject({ status: 401 })
    const forged = `${(await session('caller')).id}.${'0'.repeat(64)}`
    await expect(call(forged, 'tools/list')).resolves.toMatchObject({ status: 401 })
  })

  it('answers 405 to GET and DELETE, as a stateless server does', async () => {
    const token = mintMeshToken((await session('caller')).id)
    for (const method of ['GET', 'DELETE']) {
      const response = await handleMeshMcpRequest(
        new Request('http://mesh.internal/api/internal/mcp', {
          method,
          headers: { authorization: `Bearer ${token}` }
        })
      )
      expect(response.status).toBe(405)
    }
  })

  it('initializes and lists exactly the mesh tools', async () => {
    const token = mintMeshToken((await session('caller')).id)

    const initialized = await call(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' }
    })
    expect(initialized.status).toBe(200)
    expect(initialized.body.result.serverInfo).toEqual({ name: 'domo-agent-mesh', version: '1.0.0' })

    const listed = await call(token, 'tools/list')
    expect(initialized.body.result.instructions).toContain('development environment')
    expect(listed.body.result.tools.map((tool: any) => tool.name)).toEqual([
      'list_models',
      'list_agents',
      'get_agent',
      'read_agent_transcript',
      'message_agent',
      'cancel_agent_turn',
      'withdraw_queued_message',
      'answer_permission_request',
      'spawn_agent',
      'manage_agent_session',
      'subscribe_to_agent',
      'unsubscribe_from_agent',
      'list_subscriptions',
      'list_projects',
      'create_project',
      'update_project',
      'retire_project',
      'create_dev_environment',
      'get_dev_environment',
      'update_dev_environment',
      'retire_dev_environment',
      'retry_environment_cleanup',
      'list_environment_ports',
      'forward_environment_port',
      'schedule_task',
      'list_scheduled_tasks',
      'update_scheduled_task',
      'run_scheduled_task',
      'delete_scheduled_task',
      'notify_supervisor',
      'get_usage_limits'
    ])
  })

  it('lists the caller\'s peers and never the caller', async () => {
    const caller = await session('caller')
    const peer = await session('peer')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'list_agents')).body)

    expect(body.agents.map((agent: any) => agent.id)).toEqual([peer.id])
    expect(body.agents[0]).toMatchObject({ title: 'peer', adapter: 'claude-code' })
  })

  it('reads the useful tail of another agent transcript', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    await appendAgentEvent(peer.id, 'tool_call', { title: 'ignored' })
    await appendAgentEvent(peer.id, 'user_message', {
      content: [{ type: 'text', text: 'Please review the migration.' }]
    })
    await appendAgentEvent(peer.id, 'agent_message', { text: 'The migration is safe.' })
    await appendAgentEvent(peer.id, 'user_message', { content: [{ type: 'text', text: 'Anything else?' }] })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'read_agent_transcript', {
      agentId: peer.id,
      limit: 2,
      include: ['messages']
    })).body)

    expect(body).toMatchObject({ agentId: peer.id, title: 'peer' })
    expect(body.items).toEqual([
      { seq: expect.any(Number), kind: 'agent', text: 'The migration is safe.' },
      { seq: expect.any(Number), kind: 'user', text: 'Anything else?' }
    ])
  })

  it('returns an unknown tool as an error result, not a transport error', async () => {
    const token = mintMeshToken((await session('caller')).id)
    const { status, body } = await callTool(token, 'no_such_tool')
    expect(status).toBe(200)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('Unknown mesh tool: no_such_tool')
  })

  it('records a message on both sides and hands it to the target as a turn', async () => {
    const caller = await session('caller')
    const target = await session('target')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'message_agent', {
      agentId: target.id,
      message: 'take over the migration'
    })).body)
    expect(body).toEqual({
      delivered: true, agentId: target.id, title: 'target', delivery: 'queue', outcome: 'queued'
    })

    // An agent has no idea what its peer is in the middle of, so the default
    // waits for the turn to end rather than cutting across it.
    expect(acp.deliver).toHaveBeenCalledWith(target.id, {
      content: [{ type: 'text', text: `[Message from agent "caller" (${caller.id})]\n\ntake over the migration` }],
      delivery: 'queue',
      origin: `agent:${caller.id}`
    })
    await expect(listAgentEvents(target.id)).resolves.toMatchObject([
      { type: 'mesh_inbound', payload: { from: caller.id, fromTitle: 'caller', message: 'take over the migration', delivery: 'queue' } }
    ])
    await expect(listAgentEvents(caller.id)).resolves.toMatchObject([
      { type: 'mesh_outbound', payload: { to: target.id, toTitle: 'target', message: 'take over the migration', delivery: 'queue' } }
    ])
  })

  it('takes a delivery mode when the caller wants one, and refuses nonsense', async () => {
    const caller = await session('caller')
    const target = await session('target')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'message_agent', {
      agentId: target.id,
      message: 'drop that, do this',
      delivery: 'interrupt'
    })).body)

    expect(body).toMatchObject({ delivery: 'interrupt', outcome: 'prompted' })
    expect(acp.deliver).toHaveBeenLastCalledWith(target.id, expect.objectContaining({ delivery: 'interrupt' }))

    // The model invents values; an unknown one falls back rather than failing.
    await callTool(mintMeshToken(caller.id), 'message_agent', {
      agentId: target.id,
      message: 'hello',
      delivery: 'shout'
    })
    expect(acp.deliver).toHaveBeenLastCalledWith(target.id, expect.objectContaining({ delivery: 'queue' }))
  })

  it('spawns a peer into an environment only when asked, and on the host otherwise', async () => {
    const environment = await runningEnvironment('own')
    const caller = await session('caller', { adapter: 'codex', devEnvironmentId: environment.id })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'docs',
      prompt: 'write the README',
      devEnvironmentId: environment.id,
      // Ignored: a session in an environment runs in its workspace.
      cwd: '/elsewhere'
    })).body)

    expect(acp.create).toHaveBeenCalledWith(expect.objectContaining({
      adapter: 'codex',
      title: 'docs',
      cwd: undefined,
      devEnvironmentId: environment.id,
      initialPrompt: 'write the README'
    }))
    expect(body.id).toMatch(/^ag_/)
    await expect(listAgentEvents(caller.id)).resolves.toMatchObject([
      { type: 'mesh_spawned', payload: { agentId: body.id, title: 'docs' } }
    ])

    // Omitted, null or empty: the host, in the environment's project checkout
    // unless a directory is named, however the caller runs.
    for (const devEnvironmentId of [undefined, null, '']) {
      acp.create.mockClear()
      await callTool(mintMeshToken(caller.id), 'spawn_agent', { title: 'host', prompt: 'p', devEnvironmentId })
      expect(acp.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/domo-mesh', devEnvironmentId: null }))
    }
    acp.create.mockClear()
    await callTool(mintMeshToken(caller.id), 'spawn_agent', { title: 'host', prompt: 'p', cwd: '/tmp/elsewhere' })
    expect(acp.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/tmp/elsewhere', devEnvironmentId: null }))
  })

  it('lets a host agent spawn a peer into a running development environment', async () => {
    const environment = await runningEnvironment('target')
    const caller = await session('caller')

    await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'worker',
      prompt: 'work there',
      devEnvironmentId: environment.id
    })

    expect(acp.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: undefined,
      devEnvironmentId: environment.id
    }))
  })

  it('refuses to spawn into an environment that is not running', async () => {
    const environment = await runningEnvironment('sleeping')
    await query(`update dev_environments set status = 'stopped' where id = $1`, [environment.id])
    const caller = await session('caller')

    const { body } = await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'worker', prompt: 'work there', devEnvironmentId: environment.id
    })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('start it with update_dev_environment')
    expect(acp.create).not.toHaveBeenCalled()
  })

  it('passes a requested model through to the new session', async () => {
    const caller = await session('caller')

    await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'docs',
      prompt: 'write the README',
      model: 'haiku'
    })

    expect(acp.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }))
  })

  it('asks for no model when none is given, so the default applies', async () => {
    const caller = await session('caller')

    await callTool(mintMeshToken(caller.id), 'spawn_agent', { title: 'docs', prompt: 'go' })

    expect(acp.create).toHaveBeenCalledWith(expect.objectContaining({ model: null }))
  })
})

describe('self-scheduled tasks', () => {
  it('lets an agent create, inspect, pause, and delete its own wakeup', async () => {
    const caller = await session('caller')
    const token = mintMeshToken(caller.id)
    const created = resultOf((await callTool(token, 'schedule_task', {
      name: 'Morning check',
      prompt: 'Inspect CI and fix regressions.',
      cronExpression: '0 9 * * 1-5',
      timezone: 'UTC'
    })).body)

    expect(created).toMatchObject({
      agentId: caller.id,
      name: 'Morning check',
      delivery: 'queue',
      createdBy: `agent:${caller.id}`,
      enabled: true
    })
    const listed = resultOf((await callTool(token, 'list_scheduled_tasks')).body)
    expect(listed.jobs.map((job: any) => job.id)).toEqual([created.id])

    const paused = resultOf((await callTool(token, 'update_scheduled_task', {
      jobId: created.id,
      enabled: false,
      prompt: 'Inspect CI, fix regressions, and report the result.'
    })).body)
    expect(paused).toMatchObject({ enabled: false, nextRunAt: null })

    const deleted = resultOf((await callTool(token, 'delete_scheduled_task', { jobId: created.id })).body)
    expect(deleted).toEqual({ id: created.id, deleted: true })
    await expect(listCronJobs(caller.id)).resolves.toEqual([])
  })

  it('cannot modify a schedule owned by another agent', async () => {
    const owner = await session('owner')
    const intruder = await session('intruder')
    const created = resultOf((await callTool(mintMeshToken(owner.id), 'schedule_task', {
      name: 'Private', prompt: 'Do owner work', runAt: '2099-01-01T00:00:00Z'
    })).body)

    for (const name of ['update_scheduled_task', 'delete_scheduled_task']) {
      const { body } = await callTool(mintMeshToken(intruder.id), name, { jobId: created.id, enabled: false })
      expect(body.result.isError).toBe(true)
      expect(body.result.content[0].text).toContain('was not spawned by you')
    }
    await expect(listCronJobs(owner.id)).resolves.toHaveLength(1)
  })
})

/**
 * An agent cannot wait for a peer — its own turn ends long before the peer's
 * does — so being told is the only way it ever finds out.
 */
describe('subscriptions', () => {
  it('follows a spawned peer by default, because you cannot wait for one', async () => {
    const caller = await session('caller')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'docs',
      prompt: 'write the README'
    })).body)

    // "Tell me when this is done": its first turn, and no more.
    expect(body).toMatchObject({ notifyWhenDone: 1 })
    await expect(listAgentSubscriptions(caller.id)).resolves.toMatchObject([
      { subscriberId: caller.id, targetId: body.id, remainingTurns: 1 }
    ])
  })

  it('leaves a peer unfollowed when the caller says so', async () => {
    const caller = await session('caller')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'docs',
      prompt: 'write the README',
      notifyWhenDone: false
    })).body)

    expect(body).toMatchObject({ notifyWhenDone: false })
    await expect(listAgentSubscriptions(caller.id)).resolves.toEqual([])
  })

  it('subscribes to and unsubscribes from an existing peer', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    const token = mintMeshToken(caller.id)

    await expect(callTool(token, 'subscribe_to_agent', { agentId: peer.id }).then(r => resultOf(r.body)))
      .resolves.toEqual({ subscribed: true, agentId: peer.id, title: 'peer', turns: 1 })
    await expect(listAgentSubscriptions(caller.id)).resolves.toHaveLength(1)

    await expect(callTool(token, 'unsubscribe_from_agent', { agentId: peer.id }).then(r => resultOf(r.body)))
      .resolves.toEqual({ subscribed: false, agentId: peer.id, wasSubscribed: true })
    await expect(listAgentSubscriptions(caller.id)).resolves.toEqual([])
  })

  it('refuses an agent that does not exist, and itself', async () => {
    const caller = await session('caller')
    const token = mintMeshToken(caller.id)

    const missing = await callTool(token, 'subscribe_to_agent', { agentId: 'ag_nope' })
    expect(missing.body.result.content[0].text).toContain('No agent ag_nope')

    const self = await callTool(token, 'subscribe_to_agent', { agentId: caller.id })
    expect(self.body.result.content[0].text).toContain('cannot subscribe to itself')
  })

  it('refuses the pair that would notify each other forever', async () => {
    const one = await session('one')
    const two = await session('two')
    await callTool(mintMeshToken(one.id), 'subscribe_to_agent', { agentId: two.id })

    const back = await callTool(mintMeshToken(two.id), 'subscribe_to_agent', { agentId: one.id })

    expect(back.body.result.isError).toBe(true)
    expect(back.body.result.content[0].text).toContain('would never stop')
    await expect(listAgentSubscriptions(two.id)).resolves.toEqual([])
  })

  it('goes away with the session on either end of it', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    await callTool(mintMeshToken(caller.id), 'subscribe_to_agent', { agentId: peer.id })

    await deleteAgentSession(peer.id)

    await expect(listAgentSubscriptions(caller.id)).resolves.toEqual([])
  })
})

describe('list_models', () => {
  // The catalog itself — including one adapter failing without taking the other
  // down — is covered in `adapter-models.spec.ts`, where the spawn is faked.
  // Here it is only that the mesh reaches it and passes the filter through.
  it('hands back the catalog the picker uses, with no second spawn path', async () => {
    const caller = await session('caller')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'list_models')).body)

    expect(catalog).toHaveBeenCalledWith(undefined)
    expect(body.adapters[0]).toMatchObject({ id: 'claude-code', default: 'sonnet' })
  })

  it('filters to one harness when asked', async () => {
    const caller = await session('caller')

    await callTool(mintMeshToken(caller.id), 'list_models', { adapter: 'codex' })

    expect(catalog).toHaveBeenCalledWith('codex')
  })

  it('ignores a harness name it does not know rather than failing the call', async () => {
    const caller = await session('caller')

    await callTool(mintMeshToken(caller.id), 'list_models', { adapter: 'gpt-42' })

    expect(catalog).toHaveBeenCalledWith(undefined)
  })
})

describe('projects and dev environments', () => {
  let repoPath: string

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'domo-mesh-repo-'))
    await mkdir(join(repoPath, '.git'))
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('lists projects with their environments', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'list_projects')).body)

    expect(body.projects).toEqual([expect.objectContaining({
      id: project.id,
      name: 'domo',
      repoPath,
      environments: [expect.objectContaining({ id: environment.id, name: 'env' })]
    })])
  })

  it('creates a project from a local git checkout', async () => {
    const caller = await session('caller')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'create_project', { repoPath })).body)

    expect(body).toMatchObject({ name: expect.any(String), repoPath })
  })

  it('refuses a repo path that is not a git checkout', async () => {
    const caller = await session('caller')
    const notGit = await mkdtemp(join(tmpdir(), 'domo-mesh-not-git-'))

    const { body } = await callTool(mintMeshToken(caller.id), 'create_project', { repoPath: notGit })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/local Git checkout/)
    await rm(notGit, { recursive: true, force: true })
  })

  it('renames a project', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'update_project', {
      projectId: project.id,
      name: 'Renamed'
    })).body)

    expect(body).toEqual({ id: project.id, name: 'Renamed' })
  })

  it('retires a project and its environments, keeping every record', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'retire_project', {
      projectId: project.id
    })).body)

    expect(body).toEqual({ id: project.id, retired: true, leftovers: [] })
    expect(devEnvironments.retireEnvironment).toHaveBeenCalledWith(environment.id)
  })

  it('refuses to retire the project the caller is running in', async () => {
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const { body } = await callTool(mintMeshToken(caller.id), 'retire_project', { projectId: project.id })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/Refusing to retire the project/)
    expect(devEnvironments.retireEnvironment).not.toHaveBeenCalled()
  })

  it('creates a development environment for a project', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'create_dev_environment', {
      projectId: project.id,
      name: 'feature-x'
    })).body)

    expect(devEnvironments.beginEnvironment).toHaveBeenCalledWith({
      projectId: project.id,
      name: 'feature-x'
    })
    // At once, not when the build is done: that takes minutes.
    expect(body).toMatchObject({ id: 'env_new', name: 'feature-x', status: 'creating' })
  })

  it('starts, stops and renames a development environment', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })

    const stopped = resultOf((await callTool(mintMeshToken(caller.id), 'update_dev_environment', {
      environmentId: environment.id,
      status: 'stopped'
    })).body)
    expect(devEnvironments.stopEnvironment).toHaveBeenCalledWith(environment.id)
    expect(stopped).toMatchObject({ status: 'stopped' })

    const renamed = resultOf((await callTool(mintMeshToken(caller.id), 'update_dev_environment', {
      environmentId: environment.id,
      name: 'renamed'
    })).body)
    expect(renamed).toMatchObject({ name: 'renamed' })
  })

  it('retires a development environment and names what it stood down', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'retire_dev_environment', {
      environmentId: environment.id
    })).body)

    // `leftovers` is what Docker would not remove: empty here and normally, and
    // reported rather than swallowed, so a peer agent is not told a retirement
    // was clean when gigabytes are still on the disk.
    expect(body).toEqual({ id: environment.id, retired: true, sessionsStoodDown: [], leftovers: [], branch: null })
    expect(devEnvironments.retireEnvironment).toHaveBeenCalledWith(environment.id)
  })

  it('refuses to retire the environment the caller is running in', async () => {
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const { body } = await callTool(mintMeshToken(caller.id), 'retire_dev_environment', { environmentId: environment.id })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/Refusing to retire the environment/)
    expect(devEnvironments.retireEnvironment).not.toHaveBeenCalled()
  })

  /**
   * Nothing retries a refused removal on a timer, so an agent that reads
   * "Container X still has it mounted" has to be able to remove X and ask
   * again. This is that second ask.
   */
  it('runs the cleanup again on demand, and says what is still blocked', async () => {
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })
    const caller = await session('caller')
    devEnvironments.cleanupEnvironment.mockResolvedValue({
      removed: [{ kind: 'image', name: 'domo-dev-env_1', environmentId: environment.id }],
      leftovers: [{
        kind: 'volume',
        name: 'domo-dev-env_1-workspace',
        environmentId: environment.id,
        error: 'Container tidy-runner still has it mounted. Remove it (docker rm -f tidy-runner) and run the cleanup again.'
      }],
      unattributed: [],
      branches: []
    })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'retry_environment_cleanup', {
      environmentId: environment.id
    })).body)

    expect(devEnvironments.cleanupEnvironment).toHaveBeenCalledWith(environment.id)
    expect(body).toEqual({
      id: environment.id,
      removed: ['image domo-dev-env_1'],
      // The error carries the container to remove and the command for it, so
      // the caller can do exactly that and come back.
      leftovers: [{
        resource: 'volume domo-dev-env_1-workspace',
        error: 'Container tidy-runner still has it mounted. Remove it (docker rm -f tidy-runner) and run the cleanup again.'
      }]
    })
  })
})

/** A peer `parent` spawned over the mesh, the edge ownership follows. */
async function child(parent: { id: string }, title = 'child') {
  return session(title, { spawnedBy: parent.id })
}

const text = (body: any): string => body.result.content[0].text

describe('list_agents and get_agent', () => {
  it('filters by status, environment, project and who spawned whom, and keeps each row compact', async () => {
    const caller = await session('caller')
    const environment = await runningEnvironment('filtered')
    const working = await session('working', { devEnvironmentId: environment.id })
    await updateAgentSession(working.id, { status: 'thinking', summary: 'x'.repeat(1000) })
    const idle = await child(caller, 'idle child')
    const token = mintMeshToken(caller.id)
    const ids = async (args: any) =>
      resultOf((await callTool(token, 'list_agents', args)).body).agents.map((agent: any) => agent.id)

    await expect(ids({ status: ['thinking', 'awaiting-permission'] })).resolves.toEqual([working.id])
    await expect(ids({ environmentId: environment.id })).resolves.toEqual([working.id])
    await expect(ids({ projectId: environment.projectId })).resolves.toEqual([working.id])
    await expect(ids({ spawnedByMe: true })).resolves.toEqual([idle.id])

    const [row] = resultOf((await callTool(token, 'list_agents', { status: ['thinking'] })).body).agents
    expect(row).toMatchObject({ environmentId: environment.id, status: 'thinking' })
    expect(row).not.toHaveProperty('cwd')
    expect(row).not.toHaveProperty('settings')
    expect(row.summary.length).toBeLessThanOrEqual(201)
  })

  it('hides archived sessions unless asked, and caps the list with a note', async () => {
    const caller = await session('caller')
    const archived = await session('archived')
    await updateAgentSession(archived.id, { archived: true })
    for (let index = 0; index < 3; index++) await session(`peer ${index}`)
    const token = mintMeshToken(caller.id)

    const plain = resultOf((await callTool(token, 'list_agents')).body)
    expect(plain.agents.map((agent: any) => agent.id)).not.toContain(archived.id)
    const all = resultOf((await callTool(token, 'list_agents', { includeArchived: true })).body)
    expect(all.agents.find((agent: any) => agent.id === archived.id)).toMatchObject({ archived: true })

    const capped = resultOf((await callTool(token, 'list_agents', { limit: 2 })).body)
    expect(capped.agents).toHaveLength(2)
    expect(capped.note).toMatch(/First 2/)
  })

  it('describes your own session by default: usage, pending permissions, queued messages, spawner', async () => {
    const parent = await session('parent')
    const caller = await child(parent, 'caller')
    await setAgentUsage(caller.id, {
      context: { used: 50_000, size: 200_000 }, cost: { amount: 1.25, currency: 'USD' }, updatedAt: '2026-09-24T00:00:00Z'
    })
    const permission = await createPermission({
      agentSessionId: caller.id,
      toolCallId: null,
      title: 'Run rm -rf build',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      toolCall: null
    })
    const queued = await enqueueInboxMessage({
      agentSessionId: caller.id, content: [{ type: 'text', text: 'after this, the docs' }], delivery: 'queue', origin: 'user'
    })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'get_agent')).body)

    expect(body).toMatchObject({
      id: caller.id,
      you: true,
      spawnedBy: parent.id,
      startable: true,
      usage: { contextUsed: 50_000, contextSize: 200_000, contextPercent: 25, cost: 1.25, currency: 'USD' },
      pendingPermissions: [{ id: permission.id, title: 'Run rm -rf build', options: [{ optionId: 'allow' }] }],
      queuedMessages: [{ id: queued.id, from: 'user', text: 'after this, the docs' }]
    })
  })
})

describe('read_agent_transcript paging', () => {
  /**
   * A prompt and an answer written as two text blocks, which read as one item.
   * Three rows the digest reads per turn, so a fetch of 500 ends partway
   * through an answer, and a page that did not handle that would show half of
   * one twice or not at all.
   */
  async function turns(agentId: string, count: number) {
    for (let index = 0; index < count; index++) {
      await appendAgentEvent(agentId, 'user_message', { content: [{ type: 'text', text: `question ${index}` }] })
      // Noise the digest never reads, which a long log is mostly made of.
      await appendAgentEvent(agentId, 'tool_call_update', { status: 'completed' })
      await appendAgentEvent(agentId, 'agent_message', { text: `answer ${index}` })
      await appendAgentEvent(agentId, 'agent_message', { text: ' continued' })
    }
  }

  it('reads a log longer than one fetch in both directions, with no gaps and no repeats', async () => {
    const caller = await session('caller')
    // 700 turns is 2100 digest rows: several fetches of 500, each with an edge.
    await turns(caller.id, 700)
    const token = mintMeshToken(caller.id)
    const read = async (args: any) => resultOf((await callTool(token, 'read_agent_transcript', args)).body)

    const backwards: string[] = []
    let page = await read({ limit: 100, include: ['messages'] })
    expect(page.items.at(-1).text).toBe('answer 699 continued')
    for (;;) {
      backwards.unshift(...page.items.map((item: any) => item.text))
      if (page.olderBeforeSeq === undefined) break
      page = await read({ limit: 100, include: ['messages'], beforeSeq: page.olderBeforeSeq })
    }

    const forwards: string[] = []
    page = await read({ limit: 100, include: ['messages'], afterSeq: 0 })
    expect(page.items[0].text).toBe('question 0')
    for (;;) {
      forwards.push(...page.items.map((item: any) => item.text))
      if (page.newerAfterSeq === undefined) break
      page = await read({ limit: 100, include: ['messages'], afterSeq: page.newerAfterSeq })
    }

    const expected = Array.from({ length: 700 }, (_, index) => [`question ${index}`, `answer ${index} continued`]).flat()
    expect(backwards).toEqual(expected)
    expect(forwards).toEqual(expected)
  })

  it('reads the newest page, not the first, of a long session', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    await turns(peer.id, 1500)

    const page = resultOf((await callTool(mintMeshToken(caller.id), 'read_agent_transcript', {
      agentId: peer.id, limit: 3
    })).body)

    expect(page.items.map((item: any) => item.text)).toEqual(['answer 1498 continued', 'question 1499', 'answer 1499 continued'])
    expect(page.olderBeforeSeq).toBeDefined()
  })

  it('keeps paging when a sparse filter finds nothing within one page\'s reach', async () => {
    const caller = await session('caller')
    await appendAgentEvent(caller.id, 'plan', { entries: [{ status: 'done', content: 'first plan' }] })
    // More rows than one page will read, none of them a plan: the page has to
    // stop short and still say where to go on from.
    await query(
      `insert into agent_events (id, agent_session_id, type, payload, created_at)
       select 'ev_bulk_' || g, $1,
              case when g % 2 = 0 then 'user_message' else 'agent_message' end,
              case when g % 2 = 0 then '{"content":[{"type":"text","text":"q"}]}'::jsonb else '{"text":"a"}'::jsonb end,
              now()::text
         from generate_series(1, 20600) g`,
      [caller.id]
    )
    await appendAgentEvent(caller.id, 'plan', { entries: [{ status: 'done', content: 'second plan' }] })
    const token = mintMeshToken(caller.id)

    const plans: string[] = []
    let page = resultOf((await callTool(token, 'read_agent_transcript', { include: ['plan'], limit: 5 })).body)
    for (let calls = 0; calls < 10; calls++) {
      plans.unshift(...page.items.map((item: any) => item.text))
      if (page.olderBeforeSeq === undefined) break
      page = resultOf((await callTool(token, 'read_agent_transcript', {
        include: ['plan'], limit: 5, beforeSeq: page.olderBeforeSeq
      })).body)
    }

    expect(plans).toEqual(['done: first plan', 'done: second plan'])
  })

  it('keeps a long message whole up to maxChars', async () => {
    const caller = await session('caller')
    await appendAgentEvent(caller.id, 'agent_message', { text: 'word '.repeat(2000).trim() })
    const token = mintMeshToken(caller.id)

    const short = resultOf((await callTool(token, 'read_agent_transcript', {})).body)
    expect(short.items[0].text.length).toBe(4001)
    const long = resultOf((await callTool(token, 'read_agent_transcript', { maxChars: 20000 })).body)
    expect(long.items[0].text.endsWith('…')).toBe(false)
  })
})

describe('spawn_agent choices', () => {
  it('passes the harness and permission mode through, and records who spawned it', async () => {
    const caller = await session('caller')

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'reviewer', prompt: 'review', adapter: 'codex', modeId: 'read-only', model: 'gpt-5.6-luna'
    })).body)

    expect(acp.create).toHaveBeenCalledWith(expect.objectContaining({
      adapter: 'codex', modeId: 'read-only', model: 'gpt-5.6-luna', spawnedBy: caller.id
    }))
    expect(body).toMatchObject({ adapter: 'codex', mode: 'read-only' })
  })

  it('refuses a harness it does not know rather than guessing', async () => {
    const caller = await session('caller')

    const { body } = await callTool(mintMeshToken(caller.id), 'spawn_agent', { title: 'x', prompt: 'y', adapter: 'gemini' })

    expect(body.result.isError).toBe(true)
    expect(text(body)).toContain('Unknown adapter gemini')
    expect(acp.create).not.toHaveBeenCalled()
  })

  it('follows for as many turns as asked, or until unsubscribed', async () => {
    const caller = await session('caller')
    const token = mintMeshToken(caller.id)

    const three = resultOf((await callTool(token, 'spawn_agent', { title: 'a', prompt: 'go', notifyTurns: 3 })).body)
    const always = resultOf((await callTool(token, 'spawn_agent', { title: 'b', prompt: 'go', notifyIndefinitely: true })).body)

    expect(three.notifyWhenDone).toBe(3)
    expect(always.notifyWhenDone).toBe('indefinite')
    const held = await listAgentSubscriptions(caller.id)
    expect(held.find(entry => entry.targetId === three.id)?.remainingTurns).toBe(3)
    expect(held.find(entry => entry.targetId === always.id)?.remainingTurns).toBeNull()
  })
})

describe('subscription windows', () => {
  beforeEach(async () => {
    stopSubscriptionNotifier()
    await startSubscriptionNotifier()
  })
  afterEach(() => stopSubscriptionNotifier())

  /** The notes queued for `agentId`, in order. */
  async function notes(agentId: string): Promise<string[]> {
    return (await listInboxMessages(agentId, false)).map(message => message.content[0].text)
  }

  it('ends after the turns it covers; permissions and errors notify without using them up', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    await callTool(mintMeshToken(caller.id), 'subscribe_to_agent', { agentId: peer.id, turns: 2 })

    await createPermission({ agentSessionId: peer.id, toolCallId: null, title: 'Edit a file', options: [], toolCall: null })
    await appendAgentEvent(peer.id, 'error', { message: 'rate limited' })
    await appendAgentEvent(peer.id, 'turn_end', { stopReason: 'end_turn' })
    await expect.poll(() => notes(caller.id)).toHaveLength(3)
    await expect(listAgentSubscriptions(caller.id)).resolves.toMatchObject([{ remainingTurns: 1 }])

    await appendAgentEvent(peer.id, 'turn_end', { stopReason: 'end_turn' })
    await expect.poll(() => notes(caller.id)).toHaveLength(4)
    await expect(listAgentSubscriptions(caller.id)).resolves.toEqual([])
    const all = await notes(caller.id)
    expect(all[0]).toContain('is waiting for a permission: Edit a file')
    expect(all[1]).toContain('stopped with an error: rate limited')
    expect(all[2]).toContain('Subscribed for 1 more turn end.')
    expect(all[3]).toContain('That was the last update this subscription covered')

    // Nothing more once it has ended.
    await appendAgentEvent(peer.id, 'turn_end', { stopReason: 'end_turn' })
    await new Promise(resolve => setTimeout(resolve, 100))
    await expect(notes(caller.id)).resolves.toHaveLength(4)
  })

  it('keeps a subscription made before windows existed indefinite', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    // A row as the old code wrote it: no remaining_turns at all.
    await query(
      'insert into agent_subscriptions (subscriber_id, target_id, created_at) values ($1, $2, $3)',
      [caller.id, peer.id, new Date().toISOString()]
    )
    stopSubscriptionNotifier()
    await startSubscriptionNotifier()

    for (let index = 0; index < 3; index++) await appendAgentEvent(peer.id, 'turn_end', { stopReason: 'end_turn' })

    await expect.poll(() => notes(caller.id)).toHaveLength(3)
    await expect(listAgentSubscriptions(caller.id)).resolves.toMatchObject([{ remainingTurns: null }])
    expect((await notes(caller.id))[0]).not.toContain('Subscribed for')
  })

  it('lists what you follow and who follows you', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    const watcher = await session('watcher')
    await addAgentSubscription(caller.id, peer.id, 2)
    await addAgentSubscription(watcher.id, caller.id, null)

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'list_subscriptions')).body)

    expect(body).toMatchObject({
      following: [{ agentId: peer.id, title: 'peer', turns: 2 }],
      followers: [{ agentId: watcher.id, title: 'watcher', turns: 'indefinite' }]
    })
  })

  it('drops the subscriptions an archived session holds, and keeps the ones on it', async () => {
    const caller = await session('caller')
    const archived = await session('archived')
    const peer = await session('peer')
    await addAgentSubscription(archived.id, peer.id, null)
    await addAgentSubscription(caller.id, archived.id, 1)

    await callTool(mintMeshToken(caller.id), 'manage_agent_session', { agentId: archived.id, archived: true })

    await expect(listAgentSubscriptions(archived.id)).resolves.toEqual([])
    await expect(listAgentSubscriptions(caller.id)).resolves.toHaveLength(1)
  })
})

describe('acting on another agent', () => {
  it('cancels a peer\'s turn, says so when there is none, and never its own', async () => {
    const caller = await session('caller')
    const peer = await session('peer')
    const token = mintMeshToken(caller.id)

    const idle = resultOf((await callTool(token, 'cancel_agent_turn', { agentId: peer.id })).body)
    expect(idle).toMatchObject({ cancelled: false })
    expect(acp.cancel).not.toHaveBeenCalled()

    acp.isBusy.mockReturnValue(true)
    const busy = resultOf((await callTool(token, 'cancel_agent_turn', { agentId: peer.id })).body)
    expect(busy).toMatchObject({ cancelled: true })
    expect(acp.cancel).toHaveBeenCalledWith(peer.id)

    const self = await callTool(token, 'cancel_agent_turn', { agentId: caller.id })
    expect(text(self.body)).toContain('Refusing to cancel your own turn')
  })

  it('withdraws a queued message it sent, or any queued for an agent it spawned, and nothing else', async () => {
    const caller = await session('caller')
    const stranger = await session('stranger')
    const spawned = await child(caller)
    const queue = (agentSessionId: string, origin: any) =>
      enqueueInboxMessage({ agentSessionId, content: [{ type: 'text', text: 'hi' }], delivery: 'queue', origin })
    const mine = await queue(stranger.id, `agent:${caller.id}`)
    const theirs = await queue(stranger.id, 'user')
    const toChild = await queue(spawned.id, 'user')
    const token = mintMeshToken(caller.id)
    const withdraw = (agentId: string, messageId: string) =>
      callTool(token, 'withdraw_queued_message', { agentId, messageId }).then(response => response.body)

    expect(resultOf(await withdraw(stranger.id, mine.id))).toMatchObject({ withdrawn: true })
    expect(text(await withdraw(stranger.id, theirs.id))).toContain('was not spawned by you')
    expect(resultOf(await withdraw(spawned.id, toChild.id))).toMatchObject({ withdrawn: true })
    await expect(listInboxMessages(stranger.id)).resolves.toMatchObject([{ id: theirs.id }])
  })

  it('answers a permission request only for an agent it spawned, and only with a real option', async () => {
    const caller = await session('caller')
    const spawned = await child(caller)
    const grandchild = await child(spawned, 'grandchild')
    const stranger = await session('stranger')
    const ask = (agentSessionId: string) => createPermission({
      agentSessionId,
      toolCallId: null,
      title: 'Run the migration',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      toolCall: null
    })
    const token = mintMeshToken(caller.id)
    const answer = (agentId: string, permissionId: string, rest: any) =>
      callTool(token, 'answer_permission_request', { agentId, permissionId, ...rest }).then(response => response.body)

    const strangers = await ask(stranger.id)
    expect(text(await answer(stranger.id, strangers.id, { optionId: 'allow' }))).toContain('was not spawned by you')

    const childs = await ask(spawned.id)
    expect(text(await answer(spawned.id, childs.id, { optionId: 'yolo' }))).toContain('No option yolo')
    expect(resultOf(await answer(spawned.id, childs.id, { optionId: 'allow' }))).toMatchObject({ answered: true })
    expect(acp.answerPermission).toHaveBeenCalledWith(spawned.id, childs.id, 'allow', `agent:${caller.id}`)

    // Through an agent it spawned, too: the edge is transitive.
    const grandchilds = await ask(grandchild.id)
    expect(resultOf(await answer(grandchild.id, grandchilds.id, { reject: true }))).toMatchObject({ optionId: null })
    expect(acp.answerPermission).toHaveBeenLastCalledWith(grandchild.id, grandchilds.id, null, `agent:${caller.id}`)
    expect(acp.answerPermission).toHaveBeenCalledTimes(2)
  })
})

describe('scheduled tasks for other agents', () => {
  it('schedules, edits and runs a task for an agent it spawned, and not for anyone else', async () => {
    const caller = await session('caller')
    const spawned = await child(caller, 'watcher')
    const stranger = await session('stranger')
    const token = mintMeshToken(caller.id)

    const refused = await callTool(token, 'schedule_task', {
      agentId: stranger.id, name: 'x', prompt: 'y', cronExpression: '0 9 * * *'
    })
    expect(text(refused.body)).toContain('was not spawned by you')

    const job = resultOf((await callTool(token, 'schedule_task', {
      agentId: spawned.id, name: 'Daily watch', prompt: 'Check the adapters.', cronExpression: '0 9 * * *'
    })).body)
    expect(job).toMatchObject({ agentId: spawned.id, createdBy: `agent:${caller.id}` })
    const edited = resultOf((await callTool(token, 'update_scheduled_task', { jobId: job.id, prompt: 'Check them twice.' })).body)
    expect(edited).toMatchObject({ prompt: 'Check them twice.' })

    const nextRunAt = (await getCronJob(job.id))!.nextRunAt
    const ran = resultOf((await callTool(token, 'run_scheduled_task', { jobId: job.id })).body)
    expect(ran).toMatchObject({ delivered: true, agentId: spawned.id })
    // Exactly what the scheduler sends, so the test run is the real thing.
    expect(acp.deliver).toHaveBeenCalledWith(spawned.id, {
      content: [{ type: 'text', text: `[Scheduled task "Daily watch" (${job.id})]\n\nCheck them twice.` }],
      delivery: 'queue',
      origin: `cron:${job.id}`
    })
    await expect(getCronJob(job.id)).resolves.toMatchObject({ nextRunAt, runCount: 1, lastStatus: 'delivered' })

    const history = resultOf((await callTool(token, 'list_scheduled_tasks', { jobId: job.id })).body)
    expect(history.runs).toMatchObject([{ status: 'delivered', outcome: 'queued' }])
    await expect(listCronRuns(job.id)).resolves.toHaveLength(1)
  })

  it('records a failed test run as failed', async () => {
    const caller = await session('caller')
    const job = resultOf((await callTool(mintMeshToken(caller.id), 'schedule_task', {
      name: 'x', prompt: 'y', runAt: '2099-01-01T00:00:00Z'
    })).body)
    acp.deliver.mockRejectedValueOnce(new Error('adapter would not start'))

    const { body } = await callTool(mintMeshToken(caller.id), 'run_scheduled_task', { jobId: job.id })

    expect(text(body)).toContain('adapter would not start')
    await expect(listCronRuns(job.id)).resolves.toMatchObject([{ status: 'failed', error: 'adapter would not start' }])
  })
})

describe('development environments, asynchronously', () => {
  let repoPath: string

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'domo-mesh-repo-'))
    await mkdir(join(repoPath, '.git'))
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('tells the caller when the build finishes, and why when it fails', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })
    const token = mintMeshToken(caller.id)

    await callTool(token, 'create_dev_environment', { projectId: project.id, name: 'good' })
    await expect.poll(async () => (await listInboxMessages(caller.id)).map(message => message.content[0].text))
      .toEqual([expect.stringContaining('"good" (env_new) is running at /workspaces/env_new')])

    const failed = Promise.reject(new Error('postCreateCommand failed: exit 1'))
    // Handled here as well, as `beginEnvironment` does, or it is an unhandled
    // rejection until the tool gets to it.
    failed.catch(() => {})
    building.built = failed
    await callTool(token, 'create_dev_environment', { projectId: project.id, name: 'bad' })
    await expect.poll(async () => (await listInboxMessages(caller.id)).length).toBe(2)
    expect((await listInboxMessages(caller.id))[1]!.content[0].text)
      .toContain('"bad" (env_new) failed to build: postCreateCommand failed: exit 1')
  })

  it('describes an environment: status, error, adapter versions against Domo\'s, agents', async () => {
    const environment = await runningEnvironment('described')
    const caller = await session('caller', { devEnvironmentId: environment.id })
    const token = mintMeshToken(caller.id)

    await updateDevEnvironment(environment.id, { adapterVersions: { ...pinnedAdapterVersions(), codex: '0.0.1' } })
    const old = resultOf((await callTool(token, 'get_dev_environment')).body)
    expect(old).toMatchObject({
      id: environment.id,
      status: 'running',
      adapterVersions: { codex: '0.0.1' },
      domoAdapterVersions: pinnedAdapterVersions(),
      adaptersCurrent: false,
      agents: [{ id: caller.id, title: 'caller' }]
    })

    await updateDevEnvironment(environment.id, { adapterVersions: pinnedAdapterVersions(), status: 'error', lastError: 'boom' })
    const current = resultOf((await callTool(token, 'get_dev_environment')).body)
    expect(current).toMatchObject({ status: 'error', lastError: 'boom', adaptersCurrent: true })
  })

  it('refuses to stop the environment the caller runs in', async () => {
    const environment = await runningEnvironment('mine')
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const { body } = await callTool(mintMeshToken(caller.id), 'update_dev_environment', {
      environmentId: environment.id, status: 'stopped'
    })

    expect(text(body)).toContain('Refusing to stop the environment this agent is running in')
    expect(devEnvironments.stopEnvironment).not.toHaveBeenCalled()
  })

  it('lists and forwards ports, defaulting to the caller\'s environment', async () => {
    const environment = await runningEnvironment('ports')
    const caller = await session('caller', { devEnvironmentId: environment.id })
    const token = mintMeshToken(caller.id)
    ports.refreshEnvironmentPorts.mockResolvedValueOnce([
      { innerPort: 5173, service: null, protocol: 'tcp', label: 'vite', listening: true, forwarded: true, url: 'http://127.0.0.1:49153' },
      { innerPort: 5432, service: 'db', protocol: 'tcp', label: null, listening: true, forwarded: false, url: null },
      { innerPort: 53, protocol: 'udp', listening: true, forwarded: false, url: null }
    ])

    const listed = resultOf((await callTool(token, 'list_environment_ports')).body)
    expect(listed.ports).toEqual([
      { port: 5173, label: 'vite', listening: true, forwarded: true, url: 'http://127.0.0.1:49153' },
      // A container the environment started on the host daemon, by its name.
      { service: 'db', port: 5432, listening: true, forwarded: false }
    ])

    const forwarded = resultOf((await callTool(token, 'forward_environment_port', { port: 3000 })).body)
    expect(forwarded).toMatchObject({ port: 3000, forwarded: true, url: 'http://127.0.0.1:49152' })
    expect(ports.forwardEnvironmentPort).toHaveBeenCalledWith(environment.id, 3000, null)

    await callTool(token, 'forward_environment_port', { port: 5432, service: 'db' })
    expect(ports.forwardEnvironmentPort).toHaveBeenLastCalledWith(environment.id, 5432, 'db')

    await callTool(token, 'forward_environment_port', { port: 3000, forward: false })
    expect(ports.unforwardEnvironmentPort).toHaveBeenCalledWith(environment.id, 3000, null)
  })
})

describe('notify_supervisor', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'domo-mesh-files-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps a notification, with its files, until the human has seen it', async () => {
    const caller = await session('caller', { cwd: dir })
    await writeFile(join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 1, 2, 255]))

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'notify_supervisor', {
      message: 'The watcher found a new adapter release.',
      urgent: true,
      files: ['shot.png']
    })).body)

    expect(body).toMatchObject({ delivered: true, spoken: false, attachments: ['shot.png'] })
    await expect(getNotification(body.notificationId)).resolves.toMatchObject({
      agentSessionId: caller.id,
      agentTitle: 'caller',
      message: 'The watcher found a new adapter release.',
      urgent: true,
      seenAt: null,
      attachments: [{ name: 'shot.png', mimeType: 'image/png', size: 8 }]
    })
    // Byte for byte: a screenshot must survive the copy.
    expect(await readFile(attachmentPath(body.notificationId, 0))).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0, 1, 2, 255]))
  })

  it('writes nothing when a file cannot be read', async () => {
    const caller = await session('caller', { cwd: dir })

    const { body } = await callTool(mintMeshToken(caller.id), 'notify_supervisor', {
      message: 'see attached', files: ['missing.log']
    })

    expect(body.result.isError).toBe(true)
    expect(text(body)).toContain(`No file at ${join(dir, 'missing.log')}`)
    await expect(query('select * from notifications')).resolves.toEqual([])
  })
})
