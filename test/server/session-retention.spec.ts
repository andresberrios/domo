import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import { acpManager } from '../../server/lib/acp/manager'
import { RetiredSessionError } from '../../server/lib/acp/retirement'
import { applyAgentSessionPatch } from '../../server/lib/acp/session-settings'
import {
  purgeAgentSession,
  retireAgentSession,
  retireEnvironmentSessions,
  reviveAgentSession
} from '../../server/lib/session-retention'
import { callMeshTool } from '../../server/lib/mesh/tools'
import { cronScheduler } from '../../server/lib/cron/scheduler'
import {
  addAgentSubscription,
  appendAgentEvent,
  createAgentSession,
  createCronJob,
  createDevEnvironmentRow,
  createPermission,
  createProject,
  enqueueInboxMessage,
  getAgentSession,
  getCronJob,
  getDevEnvironment,
  getProject,
  listAgentEvents,
  listAgentSessions,
  listAgentSubscriptions,
  listDevEnvironments,
  listPermissions,
  listProjects,
  listRetiredAgentSessions,
  softDeleteDevEnvironmentRow,
  softDeleteProject
} from '../../server/lib/repo'

/**
 * Retirement, against a real Postgres.
 *
 * Two properties are what this file exists for, and both are the kind that a
 * mock would happily lie about. The first is that **the transcript survives** —
 * the row and every one of its `agent_events` are still there afterwards, which
 * only a real foreign key can tell you. The second is that **a retired session
 * cannot be started**, on every path that can start one; `spawn` is stubbed to
 * throw here, so any guard that lets a boot through fails loudly rather than
 * silently starting a process.
 */

const spawned = vi.hoisted(() => ({ calls: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: (...args: unknown[]) => {
      spawned.calls++
      throw new Error(`a retired session must never spawn an adapter (${JSON.stringify(args[0])})`)
    }
  }
})

beforeEach(async () => {
  await query('truncate projects, voice_sessions, agent_sessions, settings cascade')
  spawned.calls = 0
})

afterEach(() => {
  cronScheduler.stop()
})

async function agent(overrides: Partial<Parameters<typeof createAgentSession>[0]> = {}) {
  return createAgentSession({
    adapter: 'claude-code',
    title: 'Auth refactor',
    cwd: '/srv/api',
    ...overrides
  })
}

/** A project with one environment, as a real cascade would find it. */
async function environment() {
  const project = await createProject({ name: 'api', repoPath: '/srv/api' })
  const created = await createDevEnvironmentRow({
    projectId: project.id,
    name: 'feature-auth',
    containerName: 'domo-dev-env_x',
    workspacePath: '/workspaces/feature-auth'
  })
  return { project, environment: created }
}

describe('retiring a session', () => {
  it('keeps the row and the whole transcript', async () => {
    const session = await agent()
    await appendAgentEvent(session.id, 'user_message', { content: [{ type: 'text', text: 'go' }] })
    await appendAgentEvent(session.id, 'agent_message', { text: 'done', streaming: false })

    await retireAgentSession(session.id, 'user')

    const after = await getAgentSession(session.id)
    expect(after).toMatchObject({ retiredReason: 'user', archived: true, status: 'stopped' })
    expect(after?.retiredAt).toBeTruthy()
    // The point of the whole feature: the log is still readable afterwards.
    const events = await listAgentEvents(session.id)
    expect(events.map(event => event.type)).toEqual(['user_message', 'agent_message', 'retired'])
  })

  it('takes it off every live list without any caller asking for that', async () => {
    // Retiring sets `archived` too, which is what makes the existing
    // `where archived = false` in `listAgentSessions` — the query the voice
    // agent, the mesh and the sidebar all read — exclude it for free.
    const session = await agent()
    await retireAgentSession(session.id, 'user')

    await expect(listAgentSessions().then(rows => rows.map(row => row.id))).resolves.toEqual([])
    await expect(listRetiredAgentSessions().then(rows => rows.map(row => row.id))).resolves.toEqual([session.id])
  })

  it('is idempotent, and the first reason is the one that stuck', async () => {
    const session = await agent()
    const first = await retireAgentSession(session.id, 'environment-deleted')
    const second = await retireAgentSession(session.id, 'user')

    expect(second?.session.retiredReason).toBe('environment-deleted')
    expect(second?.session.retiredAt).toBe(first?.session.retiredAt)
  })

  it('stands down the schedules, subscriptions and permissions pointed at it', async () => {
    const session = await agent()
    const peer = await agent({ title: 'Peer' })
    const job = await createCronJob({
      agentSessionId: session.id,
      name: 'nightly',
      prompt: 'check the build',
      scheduleType: 'cron',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      runAt: null,
      enabled: true,
      delivery: 'queue',
      nextRunAt: '2099-01-01T09:00:00.000Z',
      createdBy: 'user'
    })
    await addAgentSubscription(peer.id, session.id)
    await createPermission({
      agentSessionId: session.id,
      toolCallId: 'tc_1',
      title: 'Run `rm -rf /`',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      toolCall: null
    })

    const outcome = await retireAgentSession(session.id, 'user')

    expect(outcome).toMatchObject({ cronJobsDisabled: 1, subscriptionsRemoved: 1, permissionsCancelled: 1 })
    expect(await getCronJob(job.id)).toMatchObject({ enabled: false, nextRunAt: null })
    await expect(listAgentSubscriptions(peer.id)).resolves.toEqual([])
    // Cancelled, and *named* as cancelled: "nobody ever answered this" is a
    // different fact from "the auto-approve setting answered it".
    const permissions = await listPermissions(session.id, false)
    expect(permissions[0]).toMatchObject({ resolvedBy: 'retired', resolvedOptionId: null })
  })
})

describe('the read-only guarantee', () => {
  it('refuses every path that could start the adapter, without spawning one', async () => {
    const session = await agent()
    await retireAgentSession(session.id, 'user')

    await expect(acpManager.start(session.id)).rejects.toThrow(RetiredSessionError)
    await expect(
      acpManager.deliver(session.id, { content: [{ type: 'text', text: 'hi' }] })
    ).rejects.toThrow(RetiredSessionError)
    await expect(acpManager.prompt(session.id, [{ type: 'text', text: 'hi' }])).rejects.toThrow(RetiredSessionError)
    await expect(acpManager.setMode(session.id, 'plan')).rejects.toThrow(RetiredSessionError)
    await expect(acpManager.setModel(session.id, 'opus')).rejects.toThrow(RetiredSessionError)
    await expect(acpManager.setConfigOption(session.id, 'effort', 'high')).rejects.toThrow(RetiredSessionError)

    expect(spawned.calls).toBe(0)
  })

  it('refuses the inbox write the subscription notifier makes directly', async () => {
    // `notifySubscribers` writes the row itself rather than calling `deliver`,
    // because `deliver` starts the adapter it delivers to. That makes this the
    // one delivery path a guard in `deliver` alone would miss.
    const session = await agent()
    await retireAgentSession(session.id, 'user')

    await expect(
      enqueueInboxMessage({
        agentSessionId: session.id,
        content: [{ type: 'text', text: 'your peer finished' }],
        delivery: 'queue',
        origin: 'system'
      })
    ).rejects.toThrow(RetiredSessionError)
  })

  it('refuses a new schedule, and disables one that raced the retirement', async () => {
    const session = await agent()
    const input = {
      agentSessionId: session.id,
      name: 'nightly',
      prompt: 'check the build',
      scheduleType: 'cron' as const,
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      runAt: null,
      enabled: true,
      delivery: 'queue' as const,
      nextRunAt: '2020-01-01T09:00:00.000Z',
      createdBy: 'user' as const
    }
    const job = await createCronJob(input)
    // Retire by hand *without* the orchestration, so the job is left due and
    // enabled — exactly the state a job claimed in the same tick would be in.
    await query(
      `update agent_sessions set retired_at = $2, retired_reason = 'user', archived = true where id = $1`,
      [session.id, new Date().toISOString()]
    )

    await cronScheduler.tick()

    expect(await getCronJob(job.id)).toMatchObject({ enabled: false })
    expect(spawned.calls).toBe(0)
    await expect(createCronJob(input)).rejects.toThrow(RetiredSessionError)
  })

  it('refuses everything but a rename through the settings patch', async () => {
    const session = await agent()
    await retireAgentSession(session.id, 'user')
    const retired = (await getAgentSession(session.id))!

    await expect(applyAgentSessionPatch(retired, { modeId: 'plan' })).rejects.toThrow(RetiredSessionError)
    await expect(applyAgentSessionPatch(retired, { model: 'opus' })).rejects.toThrow(RetiredSessionError)
    await expect(applyAgentSessionPatch(retired, { config: { effort: 'high' } })).rejects.toThrow(RetiredSessionError)
    // Unarchiving is not revival: it would put the session back on every live
    // list while it is still read-only.
    await expect(applyAgentSessionPatch(retired, { archived: false })).rejects.toThrow(RetiredSessionError)

    await expect(applyAgentSessionPatch(retired, { title: 'Auth refactor (done)' }))
      .resolves.toMatchObject({ title: 'Auth refactor (done)' })
  })

  it('refuses a retired caller and a retired target on the mesh', async () => {
    const caller = await agent({ title: 'Caller' })
    const target = await agent({ title: 'Target' })
    await retireAgentSession(target.id, 'user')

    await expect(callMeshTool(caller.id, 'message_agent', { agentId: target.id, message: 'hi' }))
      .rejects.toThrow(RetiredSessionError)
    await expect(callMeshTool(caller.id, 'subscribe_to_agent', { agentId: target.id }))
      .rejects.toThrow(RetiredSessionError)

    // A token already in a dying adapter's hands outlives the retirement.
    await retireAgentSession(caller.id, 'user')
    await expect(callMeshTool(caller.id, 'list_agents', {})).rejects.toThrow(RetiredSessionError)
  })
})

describe('reviving', () => {
  it('brings a host session back, stopped, and says so in the transcript', async () => {
    const session = await agent()
    await retireAgentSession(session.id, 'user')

    const revived = await reviveAgentSession(session.id)

    expect(revived).toMatchObject({ retiredAt: null, retiredReason: null, archived: false, status: 'stopped' })
    const events = await listAgentEvents(session.id)
    expect(events.map(event => event.type)).toEqual(['retired', 'revived'])
    await expect(listAgentSessions().then(rows => rows.map(row => row.id))).resolves.toEqual([session.id])
  })

  it('brings back a container session while its environment is alive', async () => {
    const { environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    await retireAgentSession(session.id, 'user')

    await expect(reviveAgentSession(session.id)).resolves.toMatchObject({ retiredAt: null })
  })

  it('refuses one whose environment was deleted, and says why', async () => {
    const { environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    await retireAgentSession(session.id, 'environment-deleted')
    await softDeleteDevEnvironmentRow(env.id)

    await expect(reviveAgentSession(session.id)).rejects.toThrow(/feature-auth/)
  })

  it('refuses a session that is not retired', async () => {
    const session = await agent()

    await expect(reviveAgentSession(session.id)).rejects.toThrow(RetiredSessionError)
  })
})

describe('the environment cascade', () => {
  it('retires the sessions instead of deleting them, and tombstones the rows', async () => {
    const { project, environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    await appendAgentEvent(session.id, 'agent_message', { text: 'shipped it', streaming: false })

    await retireEnvironmentSessions(env.id, 'environment-deleted')
    await softDeleteDevEnvironmentRow(env.id)
    await softDeleteProject(project.id)

    expect(await getAgentSession(session.id)).toMatchObject({ retiredReason: 'environment-deleted' })
    expect((await listAgentEvents(session.id)).some(event => event.type === 'agent_message')).toBe(true)
    // The tombstones stay: a transcript that cannot say where it ran is worth
    // less, and both are still readable by id.
    expect(await getDevEnvironment(env.id)).toMatchObject({ name: 'feature-auth', deletedAt: expect.any(String) })
    expect(await getProject(project.id)).toMatchObject({ deletedAt: expect.any(String) })
    await expect(listDevEnvironments()).resolves.toEqual([])
    await expect(listProjects()).resolves.toEqual([])
  })

  it('drops an environment tombstone once its last session is purged', async () => {
    const { project, environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    await retireEnvironmentSessions(env.id, 'environment-deleted')
    await softDeleteDevEnvironmentRow(env.id)
    await softDeleteProject(project.id)

    await purgeAgentSession(session.id)

    // Nothing names them any more, so "never delete anything" stops meaning
    // "accumulate rows for ever".
    expect(await getAgentSession(session.id)).toBeNull()
    expect(await getDevEnvironment(env.id)).toBeNull()
    expect(await getProject(project.id)).toBeNull()
  })

  it('refuses to purge a session that has not been retired first', async () => {
    const session = await agent()

    await expect(purgeAgentSession(session.id)).rejects.toThrow(RetiredSessionError)
    expect(await getAgentSession(session.id)).toBeTruthy()
  })
})
