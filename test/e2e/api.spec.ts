import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { afterAll, describe, expect, it } from 'vitest'

import {
  appendAgentEvent,
  createAgentSession,
  createPermission,
  listPermissions,
  listProjects
} from '../../server/lib/repo'
import { APP_BUILD_DIR } from '../helpers/app-build'
import { startElectricStub } from '../helpers/electric-stub'
import type { AgentEvent, AppSettings, PendingPermission, Project, VoiceSession } from '~~/shared/types'

/**
 * The whole stack, without a browser: a real production build of the Nitro
 * server, the real API routes, the real Postgres. The test process talks to the
 * same database, so a flow can be driven over HTTP and checked in the tables.
 *
 * Two boundaries are not real here, and cannot be: the ACP adapters (spawning
 * Claude Code would be a live API call) and ElectricSQL (it is bound to the
 * developer's own database, not to this throwaway one). Permissions are still
 * exercised end to end, because a permission is a row — `answerPermission`
 * resolves it whether or not an adapter is listening.
 */

const electric = await startElectricStub()
const checkout = await mkdtemp(join(tmpdir(), 'domo-e2e-repo-'))
await mkdir(join(checkout, '.git'), { recursive: true })

afterAll(async () => {
  await electric.close()
  await rm(checkout, { recursive: true, force: true })
})

await setup({
  server: true,
  // The build already happened in the project's `globalSetup`, and is the same
  // one the `electric` layer runs: `test/helpers/app-build.ts`.
  build: false,
  buildDir: APP_BUILD_DIR,
  browser: false,
  env: {
    // Explicit, never inherited: a leaked DATABASE_URL would write to the
    // developer's own database, and these assertions would not notice.
    DATABASE_URL: process.env.DATABASE_URL!,
    NUXT_DATA_DIR: process.env.NUXT_DATA_DIR!,
    ELECTRIC_URL: electric.url,
    NUXT_GEMINI_API_KEY: '',
    NUXT_ANTHROPIC_API_KEY: '',
    NUXT_CODEX_API_KEY: '',
    NUXT_OPENAI_API_KEY: ''
  }
})

describe('health', () => {
  it('reports both backing services', async () => {
    await expect($fetch('/api/health')).resolves.toMatchObject({
      db: true,
      electric: true,
      electricUrl: electric.url
    })
  })
})

describe('projects', () => {
  it('registers a local Git checkout and writes it to the database', async () => {
    const project = await $fetch<Project>('/api/projects', {
      method: 'POST',
      body: { repoPath: checkout }
    })

    expect(project).toMatchObject({ repoPath: checkout, name: checkout.split('/').pop() })
    // The row is really in the test database, not in the developer's own.
    await expect(listProjects()).resolves.toEqual([expect.objectContaining({ id: project.id })])
  })

  it('refuses a path that is not a Git checkout', async () => {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: tmpdir() })
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      statusMessage: 'Repository path must be a local Git checkout.'
    })
  })

  it('requires a path at all', async () => {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })

    expect(response.status).toBe(400)
  })

  it('deletes a project and everything under it', async () => {
    const project = await $fetch<Project>('/api/projects', { method: 'POST', body: { repoPath: checkout } })

    await expect($fetch(`/api/projects/${project.id}`, { method: 'DELETE' })).resolves.toEqual({ ok: true })
    await expect($fetch<Project[]>('/api/projects')).resolves.not.toContainEqual(
      expect.objectContaining({ id: project.id })
    )
  })

  it('has no dev environments until one is made', async () => {
    await expect($fetch('/api/dev-environments')).resolves.toEqual([])
  })

  it('will not create a dev environment without a project and a name', async () => {
    const response = await fetch('/api/dev-environments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'api' })
    })

    expect(response.status).toBe(400)
  })
})

describe('conversations', () => {
  it('creates one that Domo is free to name', async () => {
    const session = await $fetch<VoiceSession>('/api/voice-sessions', { method: 'POST', body: {} })

    expect(session).toMatchObject({ title: 'New conversation', titleSource: 'auto', status: 'idle' })
  })

  it('hands naming to the user on a rename, and back again', async () => {
    const session = await $fetch<VoiceSession>('/api/voice-sessions', { method: 'POST', body: {} })

    await expect($fetch<VoiceSession>(`/api/voice-sessions/${session.id}`, {
      method: 'PATCH',
      body: { title: 'Payments' }
    })).resolves.toMatchObject({ title: 'Payments', titleSource: 'user' })

    await expect($fetch<VoiceSession>(`/api/voice-sessions/${session.id}`, {
      method: 'PATCH',
      body: { autoTitle: true }
    })).resolves.toMatchObject({ title: 'Payments', titleSource: 'auto' })
  })

  it('404s on a conversation that does not exist', async () => {
    const response = await fetch('/api/voice-sessions/vs_nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' })
    })

    expect(response.status).toBe(404)
  })

  it('archives instead of deleting from the list', async () => {
    const session = await $fetch<VoiceSession>('/api/voice-sessions', { method: 'POST', body: {} })
    await $fetch(`/api/voice-sessions/${session.id}`, { method: 'PATCH', body: { archived: true } })

    await expect($fetch<VoiceSession[]>('/api/voice-sessions')).resolves.not.toContainEqual(
      expect.objectContaining({ id: session.id })
    )
  })
})

describe('a coding agent as the UI sees it', () => {
  it('serves the event log and answers a permission over HTTP', async () => {
    // The adapter subprocess is the one thing that cannot run in a test, so the
    // session and its log are seeded directly; everything after is the real API.
    const session = await createAgentSession({
      adapter: 'claude-code',
      title: 'Auth refactor',
      cwd: checkout
    })
    await appendAgentEvent(session.id, 'user_message', { content: [{ type: 'text', text: 'fix the build' }] })
    const chunk = await appendAgentEvent(session.id, 'agent_message_chunk', {
      content: { type: 'text', text: 'Looking at it.' }
    })
    const permission = await createPermission({
      agentSessionId: session.id,
      toolCallId: 'call_1',
      title: 'Run `pnpm install`',
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
      ],
      toolCall: { title: 'Bash', rawInput: { command: 'pnpm install' } }
    })

    await expect($fetch(`/api/agents/${session.id}`)).resolves.toMatchObject({ title: 'Auth refactor' })

    const events = await $fetch<AgentEvent[]>(`/api/agents/${session.id}/events`)
    expect(events.map(event => event.type)).toEqual(['user_message', 'agent_message_chunk'])

    const tail = await $fetch<AgentEvent[]>(`/api/agents/${session.id}/events`, { query: { since: chunk.seq - 1 } })
    expect(tail).toHaveLength(1)

    await expect($fetch<PendingPermission[]>(`/api/agents/${session.id}/permissions`))
      .resolves.toEqual([expect.objectContaining({ id: permission.id, resolvedAt: null })])

    await expect($fetch(`/api/permissions/${permission.id}/answer`, {
      method: 'POST',
      body: { optionId: 'allow' }
    })).resolves.toEqual({ ok: true })

    // Resolved in the database, by the user, and gone from the pending list.
    await expect(listPermissions(session.id, false)).resolves.toEqual([
      expect.objectContaining({ resolvedOptionId: 'allow', resolvedBy: 'user' })
    ])
    await expect($fetch<PendingPermission[]>(`/api/agents/${session.id}/permissions`)).resolves.toEqual([])
  })

  it('refuses to answer a permission twice', async () => {
    const session = await createAgentSession({ adapter: 'codex', title: 'Docs', cwd: checkout })
    const permission = await createPermission({
      agentSessionId: session.id,
      toolCallId: null,
      title: 'Write the readme',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      toolCall: null
    })
    await $fetch(`/api/permissions/${permission.id}/answer`, { method: 'POST', body: { optionId: 'allow' } })

    const response = await fetch(`/api/permissions/${permission.id}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optionId: 'allow' })
    })

    expect(response.status).toBe(404)
  })

  it('404s on an agent session that does not exist', async () => {
    expect((await fetch('/api/agents/ag_nope')).status).toBe(404)
  })
})

describe('settings', () => {
  it('serves the defaults, and says which keys are configured', async () => {
    const settings = await $fetch<AppSettings & { hasGeminiKey: boolean }>('/api/settings')

    expect(settings).toMatchObject({ voiceName: 'Puck', autoTitle: true, hasGeminiKey: false })
    expect(settings.systemInstruction).toContain('You are Domo')
  })

  it('persists a patch and leaves the rest alone', async () => {
    await $fetch('/api/settings', { method: 'PATCH', body: { voiceName: 'Charon', autoApprovePermissions: true } })

    await expect($fetch<AppSettings>('/api/settings')).resolves.toMatchObject({
      voiceName: 'Charon',
      autoApprovePermissions: true,
      autoTitle: true
    })
  })
})

describe('mcp servers', () => {
  it('creates an http server and lists it', async () => {
    const server = await $fetch<{ id: string }>('/api/mcp-servers', {
      method: 'POST',
      body: { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' }
    })

    await expect($fetch('/api/mcp-servers')).resolves.toContainEqual(
      expect.objectContaining({ id: server.id, enabled: true, scope: 'both' })
    )
  })

  it.each([
    [{ transport: 'http', url: 'https://example.com' }, 'name is required'],
    [{ name: 'x' }, 'transport is required'],
    [{ name: 'x', transport: 'stdio' }, 'command is required for stdio servers'],
    [{ name: 'x', transport: 'sse' }, 'url is required for http/sse servers']
  ])('rejects %j', async (body, message) => {
    const response = await fetch('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ statusMessage: message })
  })
})

describe('the Electric shape proxy', () => {
  it('only proxies tables the browser is allowed to sync', async () => {
    const response = await fetch('/api/shape?table=settings&offset=-1')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ statusMessage: 'Unknown shape table: settings' })
  })

  it('needs a table at all', async () => {
    expect((await fetch('/api/shape?offset=-1')).status).toBe(400)
  })

  it('forwards the shape definition and Electric\'s protocol params, and nothing else', async () => {
    const before = electric.requests.length
    await fetch('/api/shape?table=agent_events&where=agent_session_id+%3D+%241&params%5B1%5D=ag_1'
      + '&offset=0_0&handle=42-1700000000000&live=true&cursor=7&secret=leak')

    const received = electric.requests[before]!
    expect(received.pathname).toBe('/v1/shape')
    expect(Object.fromEntries(received.searchParams)).toEqual({
      table: 'agent_events',
      where: 'agent_session_id = $1',
      'params[1]': 'ag_1',
      offset: '0_0',
      handle: '42-1700000000000',
      live: 'true',
      cursor: '7',
      // Full rows on update, or the client cache goes stale.
      replica: 'full'
    })
  })

  it('always asks for full rows, whatever the client says', async () => {
    const before = electric.requests.length
    // `replica` is neither a protocol param nor part of the shape definition, so
    // it is dropped on the way in and pinned to `full` on the way out. There is
    // no client-supplied value to honour, and `replica=default` would silently
    // starve the local cache of the columns an update did not touch.
    await fetch('/api/shape?table=projects&offset=-1&replica=default')
    await fetch('/api/shape?table=projects&offset=-1')

    const sent = electric.requests.slice(before)
    expect(sent.map(request => request.searchParams.getAll('replica'))).toEqual([['full'], ['full']])
  })

  it('drops content-encoding so the browser can decode the stream', async () => {
    const response = await fetch('/api/shape?table=projects&offset=-1')

    expect(response.status).toBe(200)
    // fetch() in the server already decompressed the body; the header would lie.
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('electric-handle')).toBe('42-1700000000000')
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ value: { id: 'prj_1', name: 'api' } }),
      { headers: { control: 'up-to-date' } }
    ])
  })
})

describe('the filesystem picker', () => {
  it('lists the directories under a path, with its parent', async () => {
    await mkdir(join(checkout, 'src'), { recursive: true })

    const listing = await $fetch<{ path: string, parent: string, directories: Array<{ name: string }> }>(
      '/api/fs/list',
      { query: { path: checkout } }
    )

    expect(listing.path).toBe(checkout)
    expect(listing.parent).toBeTruthy()
    // `.git` is hidden, `src` is not.
    expect(listing.directories.map(entry => entry.name)).toEqual(['src'])
  })

  it('400s on a path that is not a directory', async () => {
    expect((await fetch('/api/fs/list?path=/definitely/not/here')).status).toBe(400)
  })
})

describe('the agent-mesh MCP endpoint', () => {
  // The token secret lives in the server process, so a *valid* call cannot be
  // made from here — `test/server/mesh-mcp.spec.ts` drives the handler itself.
  // What only a real request shows is that the route is mounted, reads the
  // body, and refuses anything it did not sign.
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }
  const forged = `Bearer ag_1.${'0'.repeat(64)}`

  it('401s without a bearer token', async () => {
    const response = await fetch('/api/internal/mcp', { method: 'POST', headers, body: rpc })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { message: 'Unauthorized' } })
  })

  it('401s on a forged token', async () => {
    const response = await fetch('/api/internal/mcp', {
      method: 'POST',
      headers: { ...headers, authorization: forged },
      body: rpc
    })

    expect(response.status).toBe(401)
  })
})
