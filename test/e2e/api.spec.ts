import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { afterAll, describe, expect, it } from 'vitest'

import {
  appendAgentEvent,
  createAgentSession,
  createCronJob,
  createDevEnvironmentRow,
  createNotification,
  getNotification,
  createPermission,
  createProject,
  enqueueInboxMessage,
  getAgentSession,
  getCronJob,
  listCronRuns,
  listPermissions,
  listProjects,
  retireDevEnvironmentRow
} from '../../server/lib/repo'
import { normalizeCronJobInput } from '../../server/lib/cron/input'
import { attachmentPath } from '../../server/lib/notifications'
import { APP_BUILD_DIR } from '../helpers/app-build'
import { startElectricStub } from '../helpers/electric-stub'
import type {
  AgentEvent,
  AgentInboxMessage,
  AgentSession,
  AppSettings,
  PendingPermission,
  Project,
  ProjectPathState,
  SetupProgress,
  SetupStatus
} from '~~/shared/types'

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

const git = async (cwd: string, ...args: string[]) =>
  (await promisify(execFile)('git', ['-C', cwd, ...args])).stdout.trim()

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
    NUXT_OPENAI_API_KEY: '',
    // Blanking the keys is *not* enough to keep a real agent out of this layer:
    // on macOS Claude Code reads its login from the Keychain and starts a real,
    // billable session. Both adapters are pointed at a stub that exits instead.
    // The usage poller starts with the server and would otherwise reach a real
    // account on boot. Three locks, because one is not enough: no token at all
    // (which makes the Claude poll answer `unconfigured` before any request),
    // an unreachable API base if one ever leaks in, and the same dead stub for
    // `codex app-server` that the adapters get.
    NUXT_CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    NUXT_ANTHROPIC_API_BASE: 'http://127.0.0.1:1',
    NUXT_CLAUDE_ACP_ENTRY: join(import.meta.dirname, '..', 'helpers', 'dead-adapter.mjs'),
    NUXT_CODEX_ACP_ENTRY: join(import.meta.dirname, '..', 'helpers', 'dead-adapter.mjs'),
    NUXT_OPENCODE_ACP_ENTRY: join(import.meta.dirname, '..', 'helpers', 'dead-adapter.mjs'),
    NUXT_COPILOT_ACP_ENTRY: join(import.meta.dirname, '..', 'helpers', 'dead-adapter.mjs'),
    NUXT_COPILOT_GITHUB_TOKEN: '',
    NUXT_COPILOT_API_BASE: 'http://127.0.0.1:1',
    NUXT_CODEX_ENTRY: join(import.meta.dirname, '..', 'helpers', 'dead-adapter.mjs')
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

  it('refuses a path that is not a Git checkout unless asked to initialise it, and writes nothing', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'domo-e2e-plain-'))
    try {
      for (const repoPath of [folder, join(folder, 'new')]) {
        const response = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repoPath })
        })
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toMatchObject({ statusMessage: expect.stringMatching(/Domo can (run git init|create it)/) })
      }
      await expect(readdir(folder)).resolves.toEqual([])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('creates a missing folder as a repository on main with an empty first commit', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'domo-e2e-parent-'))
    const repoPath = join(parent, 'fresh', 'app')
    try {
      await expect($fetch<ProjectPathState>('/api/projects/inspect-path', { query: { path: repoPath } }))
        .resolves.toMatchObject({ kind: 'missing', toCreate: [join(parent, 'fresh'), repoPath] })

      const project = await $fetch<Project>('/api/projects', { method: 'POST', body: { repoPath, initialize: true } })

      expect(project).toMatchObject({ repoPath, name: 'app' })
      expect(await git(repoPath, 'branch', '--show-current')).toBe('main')
      expect(await git(repoPath, 'log', '--format=%s')).toBe('Initial commit')
      expect(await git(repoPath, 'ls-tree', '-r', 'HEAD')).toBe('')
      // So an environment can be cut from it at once.
      await expect($fetch(`/api/projects/${project.id}/repository`)).resolves.toMatchObject({ repository: true, hasCommits: true })
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('initialises a folder with files but leaves the first commit to the user', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'domo-e2e-files-'))
    try {
      await writeFile(join(repoPath, 'index.ts'), 'export {}\n')
      await expect($fetch<ProjectPathState>('/api/projects/inspect-path', { query: { path: repoPath } }))
        .resolves.toMatchObject({ kind: 'directory', empty: false })

      const project = await $fetch<Project>('/api/projects', { method: 'POST', body: { repoPath, initialize: true } })

      await expect($fetch(`/api/projects/${project.id}/repository`))
        .resolves.toMatchObject({ repository: true, hasCommits: false, filesToCommit: 1 })
      expect(await git(repoPath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('requires a path at all', async () => {
    const response = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })

    expect(response.status).toBe(400)
  })

  it('retires a project and everything under it', async () => {
    const project = await $fetch<Project>('/api/projects', { method: 'POST', body: { repoPath: checkout } })

    // `leftovers` is what Docker would not remove. Empty here and normally, and
    // reported either way rather than folded into `ok: true`.
    await expect($fetch(`/api/projects/${project.id}`, { method: 'DELETE' }))
      .resolves.toEqual({ ok: true, retired: true, leftovers: [] })
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

  // The retry for a cleanup Docker refused. Nothing retries on a timer, so
  // this route is the whole of the second attempt on the HTTP surface.
  it('says the environment is not there when a cleanup is asked for one that is not', async () => {
    const response = await fetch('/api/dev-environments/env_nope/cleanup', { method: 'POST' })
    expect(response.status).toBe(500)
    expect((await response.json()).statusMessage).toMatch(/Development environment not found/)
  })

  it('reports a project\'s repository state, and refuses a first commit for an unknown project', async () => {
    expect((await fetch('/api/projects/prj_nope/repository')).status).toBe(404)
    expect((await fetch('/api/projects/prj_nope/initial-commit', { method: 'POST' })).status).toBe(404)
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

  it('puts the requested model on the new session\'s row', async () => {
    // The row is written before the spawn, which is the part this covers. The
    // stub adapter exits immediately, and whether that leaves `error` (the boot
    // that failed) or `stopped` (the exit handler, which runs after it) is a
    // race not worth pinning down here.
    const created = await $fetch<{ id: string }>('/api/agents', {
      method: 'POST',
      body: { title: 'Cheap', adapter: 'codex', cwd: checkout, model: 'gpt-5.6-luna' }
    })

    const session = await getAgentSession(created.id)
    expect(session).toMatchObject({ adapter: 'codex', model: 'gpt-5.6-luna' })
    expect(['error', 'stopped']).toContain(session!.status)
  })

  it('changes a stopped session\'s settings in one call, without starting an adapter', async () => {
    // The route hands the whole patch to `applyAgentSessionPatch`, the same
    // function the mesh tools call, and none of it starts a process.
    // The stub adapter is what makes that a real assertion rather than a
    // hopeful one: it exits as soon as it is spawned, so a boot anywhere in
    // this call would leave `status: error` and a `lastError` behind it.
    const session = await createAgentSession({ adapter: 'claude-code', title: 'Before', cwd: checkout })

    const patched = await $fetch<{ title: string, modeId: string, model: string }>(`/api/agents/${session.id}`, {
      method: 'PATCH',
      body: { title: 'After', modeId: 'plan', model: 'opus' }
    })

    expect(patched).toMatchObject({ title: 'After', modeId: 'plan', model: 'opus' })
    const row = await getAgentSession(session.id)
    expect(row!.status).toBe('starting')
    expect(row!.lastError).toBeNull()
  })

  it('leaves the model null when none is asked for', async () => {
    const created = await $fetch<{ id: string }>('/api/agents', {
      method: 'POST',
      body: { title: 'Default', cwd: checkout }
    })

    await expect(getAgentSession(created.id).then(row => row!.model)).resolves.toBeNull()
  })

  it('serves what is queued for an agent, and lets it be taken back', async () => {
    // The adapter is a stub that exits, so nothing drains this: the row stays
    // where it is, which is exactly the state the inbox panel renders.
    const session = await createAgentSession({ adapter: 'claude-code', title: 'Queued', cwd: checkout })
    const waiting = await enqueueInboxMessage({
      agentSessionId: session.id,
      content: [{ type: 'text', text: 'then push it' }],
      delivery: 'queue',
      origin: 'agent:ag_peer'
    })

    await expect($fetch<AgentInboxMessage[]>(`/api/agents/${session.id}/inbox`)).resolves.toEqual([
      expect.objectContaining({
        id: waiting.id,
        delivery: 'queue',
        origin: 'agent:ag_peer',
        deliveredAt: null,
        content: [{ type: 'text', text: 'then push it' }]
      })
    ])

    await expect($fetch(`/api/agents/${session.id}/inbox/${waiting.id}`, { method: 'DELETE' }))
      .resolves.toEqual({ ok: true, id: waiting.id })
    await expect($fetch<AgentInboxMessage[]>(`/api/agents/${session.id}/inbox`)).resolves.toEqual([])

    // Gone is gone: a second delete is a conflict, not a silent success.
    const again = await fetch(`/api/agents/${session.id}/inbox/${waiting.id}`, { method: 'DELETE' })
    expect(again.status).toBe(409)
  })

  it('refuses a delivery mode it does not know', async () => {
    const session = await createAgentSession({ adapter: 'claude-code', title: 'Modes', cwd: checkout })

    const response = await fetch(`/api/agents/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go', delivery: 'shout' })
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ statusMessage: 'Unknown delivery: shout' })
  })

  it('archives on DELETE and keeps the transcript', async () => {
    // DELETE used to delete, and the transcript went with it. It archives now:
    // the row and its events stay, and the session is one switch away.
    const session = await createAgentSession({ adapter: 'claude-code', title: 'Archiving', cwd: checkout })
    await appendAgentEvent(session.id, 'agent_message', { text: 'what I did', streaming: false })

    await expect($fetch(`/api/agents/${session.id}`, { method: 'DELETE' }))
      .resolves.toMatchObject({ ok: true, archived: true })

    await expect(getAgentSession(session.id)).resolves.toMatchObject({ archived: true })
    const events = await $fetch<AgentEvent[]>(`/api/agents/${session.id}/events`)
    expect(events.map(event => event.type)).toEqual(['agent_message'])

    const live = await $fetch<AgentSession[]>('/api/agents')
    expect(live.map(row => row.id)).not.toContain(session.id)
    const all = await $fetch<AgentSession[]>('/api/agents', { query: { includeArchived: 'true' } })
    expect(all.map(row => row.id)).toContain(session.id)
  })

  it('purges only after archiving', async () => {
    const session = await createAgentSession({ adapter: 'claude-code', title: 'Gone', cwd: checkout })

    // A record can never be destroyed straight off the live list.
    const early = await fetch(`/api/agents/${session.id}?purge=true`, { method: 'DELETE' })
    expect(early.status).toBe(409)
    await expect(getAgentSession(session.id)).resolves.toBeTruthy()

    await $fetch(`/api/agents/${session.id}`, { method: 'DELETE' })
    await expect($fetch(`/api/agents/${session.id}?purge=true`, { method: 'DELETE' }))
      .resolves.toMatchObject({ ok: true, purged: true })
    await expect(getAgentSession(session.id)).resolves.toBeNull()
  })

  it('answers 409 on every write to a session whose environment was retired', async () => {
    const project = await createProject({ name: 'retiring', repoPath: checkout })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'gone',
      containerName: `domo-e2e-${Date.now()}`,
      workspacePath: '/workspaces/gone'
    })
    const session = await createAgentSession({
      adapter: 'claude-code',
      title: 'Stranded',
      cwd: '/workspaces/gone',
      devEnvironmentId: environment.id
    })
    // Retiring the row is what makes the session unstartable; the Docker half
    // of it needs a daemon this layer does not have.
    await retireDevEnvironmentRow(environment.id)

    for (const [path, init] of [
      [`/api/agents/${session.id}/prompt`, { method: 'POST', body: JSON.stringify({ text: 'go' }) }],
      [`/api/agents/${session.id}/start`, { method: 'POST' }],
      [`/api/agents/${session.id}`, { method: 'PATCH', body: JSON.stringify({ modeId: 'plan' }) }]
    ] as const) {
      const response = await fetch(path, {
        ...init,
        headers: { 'content-type': 'application/json' }
      } as RequestInit)

      expect.soft(`${init.method} ${path} -> ${response.status}`).toContain('409')
      await expect.soft(response.json()).resolves.toMatchObject({
        statusMessage: 'Agent session cannot be started'
      })
    }

    // Archiving is about visibility and stays available — putting away a
    // session you can no longer run is the obvious thing to do with it.
    await expect($fetch(`/api/agents/${session.id}`, { method: 'PATCH', body: { archived: true } }))
      .resolves.toMatchObject({ archived: true })
  })
})

describe('scheduled tasks', () => {
  it('404s on running a task that does not exist', async () => {
    expect((await fetch('/api/cron-jobs/cron_nope/run', { method: 'POST' })).status).toBe(404)
  })

  it('says why a run now failed, records it, and leaves the next occurrence alone', async () => {
    const project = await createProject({ name: 'scheduled', repoPath: checkout })
    const environment = await createDevEnvironmentRow({
      projectId: project.id,
      name: 'sched-gone',
      containerName: `domo-e2e-sched-${Date.now()}`,
      workspacePath: '/workspaces/sched-gone'
    })
    const session = await createAgentSession({
      adapter: 'claude-code', title: 'Scheduled', cwd: '/workspaces/sched-gone', devEnvironmentId: environment.id
    })
    const job = await createCronJob(normalizeCronJobInput({
      agentSessionId: session.id, name: 'Nightly', prompt: 'Check in.', cronExpression: '0 3 * * *'
    }))
    await retireDevEnvironmentRow(environment.id)
    const before = (await getCronJob(job.id))!
    expect(before.nextRunAt).toBeTruthy()

    const response = await fetch(`/api/cron-jobs/${job.id}/run`, { method: 'POST' })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ statusMessage: expect.stringContaining('can no longer be started') })
    await expect(listCronRuns(job.id)).resolves.toMatchObject([{ status: 'failed' }])
    await expect(getCronJob(job.id)).resolves.toMatchObject({ nextRunAt: before.nextRunAt, lastStatus: 'failed', runCount: 1 })
  })
})

describe('setup guide', () => {
  it('reports every coding agent and voice, and opens by itself on a new install', async () => {
    const status = await $fetch<SetupStatus>('/api/setup')

    expect(status.agents.map(agent => agent.id)).toEqual(['claude-code', 'codex', 'opencode', 'copilot'])
    for (const agent of status.agents) {
      expect(agent.installed).toBe(true)
      expect(['subscription', 'api-key', 'free', 'none']).toContain(agent.login)
    }
    // The test server has no Gemini key, and Gemini is the default engine.
    expect(status.voice.problem).toMatch(/Gemini/)
    expect(status.progress).toEqual({ finishedAt: null, skipped: [], checks: {} })
  })

  it('remembers skips and the end of the guide, which only its own route can write', async () => {
    await $fetch('/api/setup', { method: 'PATCH', body: { skip: 'codex' } })
    await $fetch('/api/setup', { method: 'PATCH', body: { skip: 'voice' } })
    await $fetch('/api/setup', { method: 'PATCH', body: { unskip: 'voice' } })
    // A whole-object write through the settings route is ignored.
    await $fetch('/api/settings', { method: 'PATCH', body: { setup: { finishedAt: 'x', skipped: [], checks: {} } } })
    await expect($fetch('/api/setup', { method: 'PATCH', body: { skip: 'gemini' } })).rejects.toMatchObject({ statusCode: 400 })

    expect((await $fetch<SetupStatus>('/api/setup')).progress).toMatchObject({ finishedAt: null, skipped: ['codex'] })

    const finished = await $fetch<SetupProgress>('/api/setup', { method: 'PATCH', body: { finished: true } })
    expect(finished.finishedAt).toEqual(expect.any(String))
    await expect($fetch('/api/settings')).resolves.toMatchObject({ setupDue: false })
  })
})

describe('settings', () => {
  it('serves the defaults, and says which keys are configured', async () => {
    const settings = await $fetch<AppSettings & { hasGeminiKey: boolean }>('/api/settings')

    expect(settings).toMatchObject({ vscodeSshHost: '', hasGeminiKey: false })
    expect(settings).not.toHaveProperty('autoApprovePermissions')
    expect(settings.agentVoice.geminiVoice).toBe('Puck')
  })

  it('keeps a credential, reports it as configured, and never answers it', async () => {
    await $fetch('/api/settings', { method: 'PATCH', body: { geminiApiKey: ' AIza-test ' } })
    const configured = await $fetch<Record<string, unknown>>('/api/settings')
    expect(configured.hasGeminiKey).toBe(true)
    expect(configured.credentialSources).toMatchObject({ geminiApiKey: 'saved', kyutaiApiKey: null })
    expect(configured).not.toHaveProperty('geminiApiKey')
    expect(JSON.stringify(configured)).not.toContain('AIza-test')

    // Empty removes the row; anything but a string is refused.
    await $fetch('/api/settings', { method: 'PATCH', body: { geminiApiKey: '' } })
    await expect($fetch<{ hasGeminiKey: boolean }>('/api/settings')).resolves.toMatchObject({ hasGeminiKey: false })
    await expect($fetch('/api/settings', { method: 'PATCH', body: { claudeCodeOauthToken: 42 } })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('persists a patch and leaves the rest alone', async () => {
    await $fetch('/api/settings', { method: 'PATCH', body: { vscodeSshHost: 'mac' } })

    await expect($fetch<AppSettings>('/api/settings')).resolves.toMatchObject({
      vscodeSshHost: 'mac',
      browserTools: true
    })
  })

  it('serves the home mounts a new install gets', async () => {
    const settings = await $fetch<AppSettings>('/api/settings')

    expect(settings.homeMounts).toEqual(['.ssh', '.gitconfig', '.config/gh', '.config/gcloud', '.aws', '.kube'])
  })

  it('stores home mounts a line at a time, dropping the blank ones', async () => {
    await $fetch('/api/settings', { method: 'PATCH', body: { homeMounts: ['.ssh', '  ', '.config/gh/'] } })

    await expect($fetch<AppSettings>('/api/settings')).resolves.toMatchObject({
      homeMounts: ['.ssh', '.config/gh']
    })
  })

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['an escape', '../../etc'],
    // A shared `.credentials.json` logs this machine's own Claude Code out.
    ['the Claude config', '.claude'],
    ['the Codex config, which has its own mount', '.codex']
  ])('refuses %s as a home mount, with a reason', async (_label, entry) => {
    const response = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ homeMounts: ['.ssh', entry] })
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ message: expect.stringContaining(entry) })
    // And nothing was stored.
    await expect($fetch<AppSettings>('/api/settings')).resolves.not.toMatchObject({ homeMounts: ['.ssh', entry] })
  })
})

describe('mcp servers', () => {
  it('creates an http server and lists it', async () => {
    const server = await $fetch<{ id: string }>('/api/mcp-servers', {
      method: 'POST',
      body: { name: 'linear', transport: 'http', url: 'https://mcp.linear.app/mcp' }
    })

    await expect($fetch('/api/mcp-servers')).resolves.toContainEqual(
      expect.objectContaining({ id: server.id, enabled: true })
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

describe('notifications', () => {
  async function withFiles(files: Array<{ name: string, mimeType: string, data: string }>) {
    const notification = await createNotification({
      agentSessionId: null,
      agentTitle: 'watcher',
      message: 'look',
      urgent: false,
      attachments: files.map(file => ({ name: file.name, mimeType: file.mimeType, size: file.data.length }))
    })
    await mkdir(join(process.env.NUXT_DATA_DIR!, 'notifications', notification.id), { recursive: true })
    for (const [index, file] of files.entries()) await writeFile(attachmentPath(notification.id, index), file.data)
    return notification
  }

  it('serves an image inline, and anything that could run script only as a sandboxed download', async () => {
    const notification = await withFiles([
      { name: 'shot.png', mimeType: 'image/png', data: 'png' },
      { name: 'evil.svg', mimeType: 'image/svg+xml', data: '<svg onload="alert(1)"/>' }
    ])

    const image = await fetch(`/api/notifications/${notification.id}/attachments/0`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('content-disposition')).toMatch(/^inline/)
    expect(image.headers.get('content-security-policy')).toMatch(/^sandbox/)
    await expect(image.text()).resolves.toBe('png')

    const svg = await fetch(`/api/notifications/${notification.id}/attachments/1`)
    expect(svg.headers.get('content-type')).toBe('application/octet-stream')
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff')

    expect((await fetch(`/api/notifications/${notification.id}/attachments/2`)).status).toBe(404)
  })

  it('marks the ones named seen, or all of them', async () => {
    const one = await withFiles([])
    const two = await withFiles([])

    await $fetch('/api/notifications/seen', { method: 'POST', body: { ids: [one.id] } })
    expect((await getNotification(one.id))!.seenAt).not.toBeNull()
    expect((await getNotification(two.id))!.seenAt).toBeNull()

    await $fetch('/api/notifications/seen', { method: 'POST', body: {} })
    expect((await getNotification(two.id))!.seenAt).not.toBeNull()
  })
})

describe('uploads', () => {
  it('serves what the composer uploaded, by its own name only, and an image inline', async () => {
    const form = new FormData()
    form.append('files', new Blob(['png'], { type: 'image/png' }), 'image.png')
    form.append('files', new Blob(['<svg onload="alert(1)"/>'], { type: 'image/svg+xml' }), 'evil.svg')
    const { files } = await $fetch<{ files: Array<{ name: string, path: string }> }>('/api/uploads', { method: 'POST', body: form })
    expect(files.map(file => file.name)).toEqual(['image.png', 'evil.svg'])

    const image = await fetch(`/api/uploads/${files[0]!.path.split('/').pop()}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('content-security-policy')).toMatch(/^sandbox/)
    await expect(image.text()).resolves.toBe('png')

    const svg = await fetch(`/api/uploads/${files[1]!.path.split('/').pop()}`)
    expect(svg.headers.get('content-type')).toBe('application/octet-stream')
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment/)

    // Every browser names a pasted screenshot `image.png`; each is still a file of its own.
    const again = new FormData()
    again.append('files', new Blob(['other'], { type: 'image/png' }), 'image.png')
    const second = await $fetch<{ files: Array<{ path: string }> }>('/api/uploads', { method: 'POST', body: again })
    expect(second.files[0]!.path).not.toBe(files[0]!.path)
    await expect((await fetch(`/api/uploads/${files[0]!.path.split('/').pop()}`)).text()).resolves.toBe('png')

    // Nothing but an upload's own name reaches the disk.
    expect((await fetch('/api/uploads/..%2Fsettings.json')).status).toBe(404)
    expect((await fetch('/api/uploads/up_00000000000000000000.png')).status).toBe(404)
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

  it('syncs the agent inbox, which is how the UI knows what is queued', async () => {
    const before = electric.requests.length
    const response = await fetch(
      '/api/shape?table=agent_inbox&where=agent_session_id+%3D+%241&params%5B1%5D=ag_1&offset=-1'
    )

    expect(response.status).toBe(200)
    expect(Object.fromEntries(electric.requests[before]!.searchParams)).toMatchObject({
      table: 'agent_inbox',
      where: 'agent_session_id = $1',
      'params[1]': 'ag_1',
      // The inbox is rewritten in place (`delivered_at`), so a partial row
      // would leave the panel showing a message that has already gone out.
      replica: 'full'
    })
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

describe('plan usage', () => {
  it('syncs both usage tables, which have no `id` column of their own', async () => {
    // They are keyed on what they describe — a provider, and a provider plus a
    // window — so the client supplies its own `getKey`. The proxy still has to
    // allow them through by name.
    for (const table of ['usage_limits', 'usage_providers']) {
      const response = await fetch(`/api/shape?table=${table}&offset=-1`)
      expect(response.status).toBe(200)
    }
  })

  it('answers a refresh at once, because the numbers arrive through Electric', async () => {
    // Nothing is awaited server-side: waiting here would only make the button
    // feel slower than the data it is fetching.
    const response = await $fetch<{ requested: string[] }>('/api/usage/refresh', { method: 'POST' })

    expect(response.requested).toEqual(['claude', 'codex', 'opencode', 'copilot'])
  })

  it('narrows to one provider when asked, and ignores a name it does not know', async () => {
    await expect($fetch<{ requested: string[] }>('/api/usage/refresh', {
      method: 'POST',
      body: { provider: 'codex' }
    })).resolves.toEqual({ requested: ['codex'] })

    await expect($fetch<{ requested: string[] }>('/api/usage/refresh', {
      method: 'POST',
      body: { provider: 'nonsense' }
    })).resolves.toEqual({ requested: ['claude', 'codex', 'opencode', 'copilot'] })
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
