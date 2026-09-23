import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import { acpManager } from '../../server/lib/acp/manager'
import { UnstartableSessionError } from '../../server/lib/acp/startable'
import { purgeAgentSession, setAgentSessionArchived } from '../../server/lib/agent-sessions'
import { retireProjectCascade, retireProjectEnvironment } from '../../server/lib/projects'
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
  pruneRetiredRecords,
  retireDevEnvironmentRow,
  setEnvironmentLeftovers
} from '../../server/lib/repo'

/**
 * Retiring an environment, against a real Postgres.
 *
 * Three properties are what this file exists for, and a mock would happily lie
 * about all of them. **The records survive** — the session row and every one of
 * its `agent_events` are still there afterwards, which only a real foreign key
 * can tell you. **Nothing is archived by it** — losing a container is not a
 * reason to hide anybody's work, and the two states drifting back together is
 * the regression this guards. And **the sessions cannot be started**, on every
 * path that can start one; `spawn` throws here, so a guard that lets a boot
 * through fails loudly rather than silently starting a process.
 */

const spawned = vi.hoisted(() => ({ calls: 0 }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: (...args: unknown[]) => {
      spawned.calls++
      throw new Error(`an unstartable session must never spawn an adapter (${JSON.stringify(args[0])})`)
    }
  }
})

// The Docker half is not what is under test here, and there is no daemon in
// this project. Everything above it — the rows, the guards, the cascade — is real.
vi.mock('../../server/lib/dev-environments', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/lib/dev-environments')>()
  return {
    ...original,
    retireEnvironment: async (id: string) => {
      const { retireDevEnvironmentRow, pruneRetiredRecords } = await import('../../server/lib/repo')
      await retireDevEnvironmentRow(id)
      await pruneRetiredRecords()
      // What a cleanup with a real daemon behind it reports: nothing left over.
      // The failing case is `test/docker/dev-environments.spec.ts`, where the
      // daemon is faked at the process boundary and can refuse.
      return { removed: [], leftovers: [], unattributed: [] }
    },
    ensureEnvironmentRunning: async (id: string) => {
      const { getDevEnvironment: read } = await import('../../server/lib/repo')
      return read(id)
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

const CRON = {
  name: 'nightly',
  prompt: 'check the build',
  scheduleType: 'cron' as const,
  cronExpression: '0 9 * * *',
  timezone: 'UTC',
  runAt: null,
  enabled: true,
  delivery: 'queue' as const,
  createdBy: 'user' as const
}

describe('retiring an environment', () => {
  it('keeps every row, and the whole transcript with them', async () => {
    const { project, environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    await appendAgentEvent(session.id, 'user_message', { content: [{ type: 'text', text: 'go' }] })
    await appendAgentEvent(session.id, 'agent_message', { text: 'shipped it', streaming: false })

    await retireProjectEnvironment(env.id)

    const events = await listAgentEvents(session.id)
    expect(events.map(event => event.type)).toEqual(['user_message', 'agent_message', 'environment_retired'])
    // The environment row is the only record of where that work happened.
    expect(await getDevEnvironment(env.id)).toMatchObject({
      name: 'feature-auth',
      retiredAt: expect.any(String)
    })
    expect(await getProject(project.id)).toMatchObject({ retiredAt: null })
    await expect(listDevEnvironments()).resolves.toEqual([])
  })

  it('archives nothing: the sessions stay on the list and simply cannot run', async () => {
    // The two states are independent on purpose. Losing a container is not a
    // reason to hide somebody's work, and coupling them back together would
    // make "why can I not see it" and "why can I not run it" the same question.
    const { environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })

    await retireProjectEnvironment(env.id)

    expect(await getAgentSession(session.id)).toMatchObject({ archived: false })
    await expect(listAgentSessions().then(rows => rows.map(row => row.id))).resolves.toEqual([session.id])
  })

  it('stands down the schedules, subscriptions and permissions pointed at it', async () => {
    const { environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    const peer = await agent({ title: 'Peer' })
    const job = await createCronJob({
      ...CRON,
      agentSessionId: session.id,
      nextRunAt: '2099-01-01T09:00:00.000Z'
    })
    await addAgentSubscription(peer.id, session.id)
    await createPermission({
      agentSessionId: session.id,
      toolCallId: 'tc_1',
      title: 'Run `rm -rf /`',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      toolCall: null
    })

    const retirement = await retireProjectEnvironment(env.id)

    expect(retirement).toMatchObject({ cronJobsDisabled: 1, subscriptionsRemoved: 1, permissionsCancelled: 1 })
    expect(retirement.sessions.map(item => item.id)).toEqual([session.id])
    expect(await getCronJob(job.id)).toMatchObject({ enabled: false, nextRunAt: null })
    await expect(listAgentSubscriptions(peer.id)).resolves.toEqual([])
    // Cancelled, and *named* as cancelled: "nobody ever answered this" is a
    // different fact from "the auto-approve setting answered it".
    const permissions = await listPermissions(session.id, false)
    expect(permissions[0]).toMatchObject({ resolvedBy: 'retired', resolvedOptionId: null })
  })

  it('takes a whole project down and keeps its rows too', async () => {
    const { project, environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })

    await retireProjectCascade(project.id)

    expect(await getProject(project.id)).toMatchObject({ retiredAt: expect.any(String) })
    expect(await getDevEnvironment(env.id)).toMatchObject({ retiredAt: expect.any(String) })
    expect(await getAgentSession(session.id)).toBeTruthy()
    await expect(listProjects()).resolves.toEqual([])
  })

  it('leaves no record behind for a project nothing ever ran in', async () => {
    const project = await createProject({ name: 'empty', repoPath: '/srv/empty' })

    await retireProjectCascade(project.id)

    // Nothing points at it, so `pruneRetiredRecords` drops it for real.
    expect(await getProject(project.id)).toBeNull()
  })

  /**
   * The row is the only way back to a leftover: every Docker name an
   * environment owns is derived from its id, so a volume a cleanup could not
   * remove is findable hours later — and only for as long as the row is there.
   * Pruning one that still owes something would make the leftover
   * unattributable, and then nothing could ever remove it safely.
   */
  it('keeps a retired row that still owes Docker resources, even with nothing pointing at it', async () => {
    const { environment: env } = await environment()
    await retireDevEnvironmentRow(env.id)
    await setEnvironmentLeftovers(env.id, [
      { kind: 'volume', name: 'domo-dev-env_x-workspace', error: 'volume is in use' }
    ])

    await expect(pruneRetiredRecords()).resolves.toMatchObject({ environments: 0 })
    expect(await getDevEnvironment(env.id)).toMatchObject({
      leftovers: [{ kind: 'volume', name: 'domo-dev-env_x-workspace', error: 'volume is in use' }]
    })

    // And it goes as soon as a sweep says the volume is gone.
    await setEnvironmentLeftovers(env.id, [])
    await expect(pruneRetiredRecords()).resolves.toMatchObject({ environments: 1 })
    expect(await getDevEnvironment(env.id)).toBeNull()
  })

  it('writes the leftovers only when they change, because the row is synced', async () => {
    const { environment: env } = await environment()
    const owed = [{ kind: 'volume' as const, name: 'domo-dev-env_x-workspace', error: 'volume is in use' }]

    expect(await setEnvironmentLeftovers(env.id, owed)).toMatchObject({ leftovers: owed })
    // A sweep every few minutes finds the same thing every time; `REPLICA
    // IDENTITY FULL` means each write re-streams the whole row to every browser.
    expect(await setEnvironmentLeftovers(env.id, owed)).toBeNull()
    expect(await setEnvironmentLeftovers(env.id, [])).toMatchObject({ leftovers: [] })
  })
})

describe('the read-only guarantee', () => {
  async function retiredSession() {
    const { environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    await retireProjectEnvironment(env.id)
    return session
  }

  it('refuses every path that could start the adapter, without spawning one', async () => {
    const session = await retiredSession()

    await expect(acpManager.start(session.id)).rejects.toThrow(UnstartableSessionError)
    await expect(
      acpManager.deliver(session.id, { content: [{ type: 'text', text: 'hi' }] })
    ).rejects.toThrow(UnstartableSessionError)
    await expect(acpManager.prompt(session.id, [{ type: 'text', text: 'hi' }]))
      .rejects.toThrow(UnstartableSessionError)
    // These three stopped booting an adapter, so the boot guard no longer
    // covers them: without their own check they would take the offline branch
    // and quietly write a row describing how a dead session would run.
    await expect(acpManager.setMode(session.id, 'plan')).rejects.toThrow(UnstartableSessionError)
    await expect(acpManager.setModel(session.id, 'opus')).rejects.toThrow(UnstartableSessionError)
    await expect(acpManager.setConfigOption(session.id, 'effort', 'high'))
      .rejects.toThrow(UnstartableSessionError)

    expect(spawned.calls).toBe(0)
  })

  it('refuses the inbox write the subscription notifier makes directly', async () => {
    // `notifySubscribers` writes the row itself rather than calling `deliver`,
    // because `deliver` starts the adapter it delivers to. That makes this the
    // one delivery path a guard in `deliver` alone would miss.
    const session = await retiredSession()

    await expect(
      enqueueInboxMessage({
        agentSessionId: session.id,
        content: [{ type: 'text', text: 'your peer finished' }],
        delivery: 'queue',
        origin: 'system'
      })
    ).rejects.toThrow(UnstartableSessionError)
  })

  it('refuses a new schedule, and disables one that raced the retirement', async () => {
    const { environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    const job = await createCronJob({
      ...CRON,
      agentSessionId: session.id,
      nextRunAt: '2020-01-01T09:00:00.000Z'
    })
    // Retire the environment row by hand, leaving the job due and enabled —
    // exactly the state a job claimed in the same tick would be in.
    await query(
      'update dev_environments set retired_at = $2 where id = $1',
      [env.id, new Date().toISOString()]
    )

    await cronScheduler.tick()

    expect(await getCronJob(job.id)).toMatchObject({ enabled: false })
    expect(spawned.calls).toBe(0)
    await expect(createCronJob({ ...CRON, agentSessionId: session.id, nextRunAt: '2099-01-01T09:00:00.000Z' }))
      .rejects.toThrow(UnstartableSessionError)
  })

  it('refuses a caller and a target on the mesh, and still lists them', async () => {
    const caller = await agent({ title: 'Caller' })
    const { environment: env } = await environment()
    const target = await agent({ title: 'Target', devEnvironmentId: env.id })
    await retireProjectEnvironment(env.id)

    await expect(callMeshTool(caller.id, 'message_agent', { agentId: target.id, message: 'hi' }))
      .rejects.toThrow(UnstartableSessionError)
    await expect(callMeshTool(caller.id, 'subscribe_to_agent', { agentId: target.id }))
      .rejects.toThrow(UnstartableSessionError)

    // Still listed, and marked — a peer's transcript is worth reading, and
    // being told up front beats finding out by being refused.
    const listed = await callMeshTool(caller.id, 'list_agents', {}) as {
      agents: Array<{ id: string, startable: boolean, cannotStart?: string }>
    }
    expect(listed.agents.find(item => item.id === target.id))
      .toMatchObject({ startable: false, cannotStart: expect.stringContaining('feature-auth') })
  })

  it('still lets a session that cannot run be archived and renamed', async () => {
    // Archiving is about visibility and nothing else, so it stays available:
    // putting away a session you can no longer run is the obvious thing to do
    // with it, and refusing that would make the two states one again.
    const session = await retiredSession()

    await expect(setAgentSessionArchived(session.id, true)).resolves.toMatchObject({ archived: true })
    await expect(setAgentSessionArchived(session.id, false)).resolves.toMatchObject({ archived: false })
  })
})

describe('the permanent delete', () => {
  it('is refused until the session has been archived', async () => {
    const session = await agent()

    await expect(purgeAgentSession(session.id)).rejects.toThrow(/not archived/)
    expect(await getAgentSession(session.id)).toBeTruthy()
  })

  it('destroys the transcript, and the retired rows nothing points at any more', async () => {
    const { project, environment: env } = await environment()
    const session = await agent({ devEnvironmentId: env.id })
    await appendAgentEvent(session.id, 'agent_message', { text: 'what I did', streaming: false })
    await retireProjectCascade(project.id)
    await setAgentSessionArchived(session.id, true)

    await purgeAgentSession(session.id)

    expect(await getAgentSession(session.id)).toBeNull()
    // Nothing names them now, so "never delete anything" stops meaning
    // "accumulate rows for ever".
    expect(await getDevEnvironment(env.id)).toBeNull()
    expect(await getProject(project.id)).toBeNull()
  })
})
