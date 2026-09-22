import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import {
  appendAgentEvent,
  createAgentSession,
  createDevEnvironmentRow,
  createProject,
  deleteAgentSession,
  listAgentEvents,
  listAgentSubscriptions,
  listCronJobs
} from '../../server/lib/repo'
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

const devEnvironments = vi.hoisted(() => ({
  safeEnvironmentName: (name: string) => name,
  createEnvironment: vi.fn(async (input: any) => ({
    id: 'env_new',
    projectId: input.projectId,
    name: input.name,
    status: 'running',
    workspacePath: '/workspaces/env_new',
    workspaceSeed: { mode: input.workingTree ?? 'discard', paths: [], total: 0, commit: null }
  })),
  startEnvironment: vi.fn(async (id: string) => ({ id, name: 'env', status: 'running' })),
  stopEnvironment: vi.fn(async (id: string) => ({ id, name: 'env', status: 'stopped' })),
  retireEnvironment: vi.fn(async () => {})
}))

vi.mock('../../server/lib/dev-environments', () => devEnvironments)

// The sync itself is `git-sync.spec.ts`, with real git on both ends; here it
// is only what the mesh decides before calling it. `resolveIntoBranch` /
// `resolveFromRef` stay real, because those decisions are the point.
const gitSync = vi.hoisted(() => ({
  exportBranch: vi.fn(async (input: any) => ({
    ref: `refs/remotes/domo-env/env/${input.branch}`,
    sha: 'f00d',
    commits: [],
    into: input.into,
    result: input.into ? 'fast-forwarded' : 'not-merged'
  })),
  importBranch: vi.fn(async (input: any) => ({
    branch: input.branch,
    from: input.from,
    sha: 'f00d',
    commits: [],
    result: 'fast-forwarded'
  })),
  listEnvironmentBranches: vi.fn(async () => ({ current: 'work-in-here', branches: [] }))
}))

vi.mock('../../server/lib/dev-env/git-sync', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/lib/dev-env/git-sync')>(),
  ...gitSync
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
  // The real one writes an `agent_sessions` row; anything that then points at
  // the new session — a subscription — needs that row to exist.
  acp.create.mockImplementation(async (input: any) => createAgentSession({
    adapter: input.adapter,
    title: input.title,
    cwd: input.cwd ?? '/workspace',
    devEnvironmentId: input.devEnvironmentId ?? null,
    model: input.model ?? null
  }))
  devEnvironments.createEnvironment.mockClear()
  devEnvironments.startEnvironment.mockClear()
  devEnvironments.stopEnvironment.mockClear()
  devEnvironments.retireEnvironment.mockClear()
  gitSync.exportBranch.mockClear()
  gitSync.importBranch.mockClear()
  gitSync.listEnvironmentBranches.mockClear()
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
    expect(listed.body.result.tools.map((tool: any) => tool.name)).toEqual([
      'list_models',
      'list_agents',
      'read_agent_transcript',
      'message_agent',
      'spawn_agent',
      'manage_agent_session',
      'subscribe_to_agent',
      'unsubscribe_from_agent',
      'list_projects',
      'create_project',
      'update_project',
      'retire_project',
      'create_dev_environment',
      'update_dev_environment',
      'retire_dev_environment',
      'export_branch',
      'import_branch',
      'schedule_task',
      'list_scheduled_tasks',
      'update_scheduled_task',
      'delete_scheduled_task',
      'notify_supervisor'
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
      { kind: 'agent', text: 'The migration is safe.' },
      { kind: 'user', text: 'Anything else?' }
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

  it('spawns a peer into the caller\'s own environment and adapter', async () => {
    const environment = await runningEnvironment('own')
    const caller = await session('caller', { adapter: 'codex', devEnvironmentId: environment.id })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'spawn_agent', {
      title: 'docs',
      prompt: 'write the README',
      // Ignored: an agent in an environment always spawns its peer there.
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
    expect(body.result.content[0].text).toContain('start it before spawning')
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
      agentSessionId: caller.id,
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
      expect(body.result.content[0].text).toContain('belongs to this agent')
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

    expect(body).toMatchObject({ notifyWhenDone: true })
    await expect(listAgentSubscriptions(caller.id)).resolves.toMatchObject([
      { subscriberId: caller.id, targetId: body.id }
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
      .resolves.toEqual({ subscribed: true, agentId: peer.id, title: 'peer' })
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

    expect(body).toEqual({ id: project.id, retired: true })
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

    expect(devEnvironments.createEnvironment).toHaveBeenCalledWith({
      projectId: project.id,
      name: 'feature-x',
      workingTree: 'discard'
    })
    expect(body).toMatchObject({ id: 'env_new', name: 'feature-x', status: 'running' })
  })

  // The host's uncommitted work is left behind unless the caller says otherwise:
  // an agent asking for an environment has no idea what its human left in the tree.
  it('carries the host working tree only when the caller asks for it', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })

    await callTool(mintMeshToken(caller.id), 'create_dev_environment', {
      projectId: project.id,
      name: 'feature-y',
      workingTree: 'carry'
    })

    expect(devEnvironments.createEnvironment).toHaveBeenCalledWith({
      projectId: project.id,
      name: 'feature-y',
      workingTree: 'carry'
    })
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

    expect(body).toEqual({ id: environment.id, retired: true, sessionsStoodDown: [] })
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
})

describe('export_branch', () => {
  let repoPath: string

  async function environmentFor(name = 'env') {
    const project = await createProject({ name: 'domo', repoPath })
    return createDevEnvironmentRow({
      projectId: project.id,
      name,
      containerName: `domo-${name}`,
      workspacePath: '/workspace'
    })
  }

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'domo-mesh-repo-'))
    await mkdir(join(repoPath, '.git'))
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('defaults to the caller\'s own environment, its checked-out branch and the same name on the host', async () => {
    const environment = await environmentFor()
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'export_branch')).body)

    expect(gitSync.listEnvironmentBranches).toHaveBeenCalledWith(environment.id)
    expect(gitSync.exportBranch).toHaveBeenCalledWith({
      environmentId: environment.id,
      branch: 'work-in-here',
      into: 'work-in-here'
    })
    expect(body).toMatchObject({ result: 'fast-forwarded', into: 'work-in-here' })
  })

  it('takes another environment, branch and local branch when it is given them', async () => {
    const environment = await environmentFor('other')
    const caller = await session('caller')

    await callTool(mintMeshToken(caller.id), 'export_branch', {
      devEnvironmentId: environment.id,
      branch: 'feature',
      into: 'review'
    })

    expect(gitSync.listEnvironmentBranches).not.toHaveBeenCalled()
    expect(gitSync.exportBranch).toHaveBeenCalledWith({
      environmentId: environment.id,
      branch: 'feature',
      into: 'review'
    })
  })

  it('reads an empty `into` as "fetch it, touch nothing"', async () => {
    const environment = await environmentFor()
    const caller = await session('caller', { devEnvironmentId: environment.id })

    await callTool(mintMeshToken(caller.id), 'export_branch', { branch: 'feature', into: '' })

    expect(gitSync.exportBranch).toHaveBeenCalledWith(expect.objectContaining({ into: null }))
  })

  it('tells a host session it has to name an environment', async () => {
    const caller = await session('caller')

    const { body } = await callTool(mintMeshToken(caller.id), 'export_branch', { branch: 'main' })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/pass devEnvironmentId/)
    expect(gitSync.exportBranch).not.toHaveBeenCalled()
  })

  it('imports into the caller\'s own environment, from the same name on the host', async () => {
    const environment = await environmentFor()
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'import_branch', { branch: 'main' })).body)

    expect(gitSync.importBranch).toHaveBeenCalledWith({
      environmentId: environment.id,
      branch: 'main',
      from: 'main'
    })
    expect(body).toMatchObject({ branch: 'main', result: 'fast-forwarded' })
  })

  it('takes another environment and a differently named host ref for an import', async () => {
    const environment = await environmentFor('other')
    const caller = await session('caller')

    await callTool(mintMeshToken(caller.id), 'import_branch', {
      devEnvironmentId: environment.id,
      branch: 'staging',
      from: 'main'
    })

    expect(gitSync.importBranch).toHaveBeenCalledWith({
      environmentId: environment.id,
      branch: 'staging',
      from: 'main'
    })
  })

  // Unlike an export there is nothing to fall back to: an import with no target
  // branch has nowhere to put anything.
  it('refuses an import with no branch named', async () => {
    const environment = await environmentFor()
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const { body } = await callTool(mintMeshToken(caller.id), 'import_branch', { branch: '  ' })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/Name the branch/)
    expect(gitSync.importBranch).not.toHaveBeenCalled()
  })
})
