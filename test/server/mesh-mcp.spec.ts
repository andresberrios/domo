import { beforeEach, describe, expect, it, vi } from 'vitest'

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
 * against the real Postgres — only the ACP manager is faked, because a real one
 * would spawn an adapter.
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

  it('initializes and lists exactly the four mesh tools', async () => {
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
      'list_agents',
      'message_agent',
      'spawn_agent',
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
})
