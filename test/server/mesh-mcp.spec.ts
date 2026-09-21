import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import {
  createAgentSession,
  createDevEnvironmentRow,
  createProject,
  listAgentEvents
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
  create: vi.fn(async (input: any) => ({
    id: 'ag_spawned',
    title: input.title,
    cwd: input.cwd ?? '/workspace',
    adapter: input.adapter,
    devEnvironmentId: input.devEnvironmentId
  }))
}))

vi.mock('../../server/lib/acp/manager', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/lib/acp/manager')>()
  return { ...original, acpManager: acp }
})

const devEnvironments = vi.hoisted(() => ({
  createEnvironment: vi.fn(async (input: any) => ({
    id: 'env_new',
    projectId: input.projectId,
    name: input.name,
    status: 'running',
    workspacePath: '/workspaces/env_new'
  })),
  startEnvironment: vi.fn(async (id: string) => ({ id, name: 'env', status: 'running' })),
  stopEnvironment: vi.fn(async (id: string) => ({ id, name: 'env', status: 'stopped' })),
  removeEnvironment: vi.fn(async () => {})
}))

vi.mock('../../server/lib/dev-environments', () => devEnvironments)

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

beforeEach(async () => {
  await query('truncate agent_sessions, projects cascade')
  acp.promptInBackground.mockClear()
  acp.create.mockClear()
  devEnvironments.createEnvironment.mockClear()
  devEnvironments.startEnvironment.mockClear()
  devEnvironments.stopEnvironment.mockClear()
  devEnvironments.removeEnvironment.mockClear()
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
      'message_agent',
      'spawn_agent',
      'list_projects',
      'create_project',
      'update_project',
      'delete_project',
      'create_dev_environment',
      'update_dev_environment',
      'delete_dev_environment',
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
    expect(body).toEqual({ delivered: true, agentId: target.id, title: 'target' })

    expect(acp.promptInBackground).toHaveBeenCalledWith(target.id, [
      { type: 'text', text: `[Message from agent "caller" (${caller.id})]\n\ntake over the migration` }
    ])
    await expect(listAgentEvents(target.id)).resolves.toMatchObject([
      { type: 'mesh_inbound', payload: { from: caller.id, fromTitle: 'caller', message: 'take over the migration' } }
    ])
    await expect(listAgentEvents(caller.id)).resolves.toMatchObject([
      { type: 'mesh_outbound', payload: { to: target.id, toTitle: 'target', message: 'take over the migration' } }
    ])
  })

  it('spawns a peer into the caller\'s own environment and adapter', async () => {
    const project = await createProject({ name: 'domo', repoPath: '/tmp/domo-mesh' })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })
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
    expect(body.id).toBe('ag_spawned')
    await expect(listAgentEvents(caller.id)).resolves.toMatchObject([
      { type: 'mesh_spawned', payload: { agentId: 'ag_spawned', title: 'docs' } }
    ])
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

  it('deletes a project and its environments', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'delete_project', {
      projectId: project.id
    })).body)

    expect(body).toEqual({ id: project.id, deleted: true })
    expect(devEnvironments.removeEnvironment).toHaveBeenCalledWith(environment.id)
  })

  it('refuses to delete the project the caller is running in', async () => {
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const { body } = await callTool(mintMeshToken(caller.id), 'delete_project', { projectId: project.id })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/Refusing to delete the project/)
    expect(devEnvironments.removeEnvironment).not.toHaveBeenCalled()
  })

  it('creates a development environment for a project', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'create_dev_environment', {
      projectId: project.id,
      name: 'feature-x'
    })).body)

    expect(devEnvironments.createEnvironment).toHaveBeenCalledWith({ projectId: project.id, name: 'feature-x' })
    expect(body).toMatchObject({ id: 'env_new', name: 'feature-x', status: 'running' })
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

  it('deletes a development environment', async () => {
    const caller = await session('caller')
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })

    const body = resultOf((await callTool(mintMeshToken(caller.id), 'delete_dev_environment', {
      environmentId: environment.id
    })).body)

    expect(body).toEqual({ id: environment.id, deleted: true })
    expect(devEnvironments.removeEnvironment).toHaveBeenCalledWith(environment.id)
  })

  it('refuses to delete the environment the caller is running in', async () => {
    const project = await createProject({ name: 'domo', repoPath })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'env',
      containerName: 'domo-env',
      workspacePath: '/workspace'
    })
    const caller = await session('caller', { devEnvironmentId: environment.id })

    const { body } = await callTool(mintMeshToken(caller.id), 'delete_dev_environment', { environmentId: environment.id })

    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toMatch(/Refusing to delete the environment/)
    expect(devEnvironments.removeEnvironment).not.toHaveBeenCalled()
  })
})
