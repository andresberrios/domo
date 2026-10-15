import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'

import { query } from '../../server/lib/db'
import {
  addAgentSubscription,
  addMessageWatch,
  appendAgentEvent,
  armMessageWatches,
  claimInboxMessages,
  createAgentSession,
  createDevEnvironmentRow,
  createMcpServer,
  createPermission,
  createProject,
  deleteAgentSession,
  deleteInboxMessage,
  pruneRetiredProjects,
  getAgentSession,
  enqueueInboxMessage,
  latestAgentMessage,
  listAgentEvents,
  listAgentSessions,
  listAgentSubscribers,
  listAgentSubscriptions,
  listDevEnvironmentPorts,
  listDevEnvironments,
  listInboxMessages,
  listMcpServers,
  listPermissions,
  listProjects,
  openAgentStream,
  releaseInboxMessages,
  removeAgentSubscription,
  restartBlockers,
  resolvePermissionRow,
  nameAgentSession,
  titleUntitledAgentSession,
  UNTITLED_AGENT_TITLE,
  updateAgentSession,
  updateDevEnvironment,
  updateDevEnvironmentPort,
  updateMcpServer,
  retireProjectRow,
  upsertDevEnvironmentPort,
  writeAgentStream
} from '../../server/lib/repo'
import { captureBus } from '../helpers/bus'

/**
 * `server/lib/repo.ts` is the only door to the database, and the only place the
 * bus gets told about a write. Everything here runs against a real Postgres:
 * the snake_case-to-domain mapping, the conditional updates and the foreign
 * keys are exactly what a stubbed driver would paper over.
 */

const seen = captureBus()
afterAll(() => seen.stop())

beforeEach(async () => {
  // Projects and sessions cascade to everything else.
  await query('truncate projects, agent_sessions, mcp_servers, settings cascade')
  seen.clear()
})

afterEach(() => seen.clear())

async function project() {
  return createProject({ name: 'api', repoPath: '/srv/api' })
}

async function agent(overrides: Parameters<typeof createAgentSession>[0] | null = null) {
  return createAgentSession(overrides ?? { adapter: 'claude-code', title: 'Auth refactor', cwd: '/srv/api' })
}

describe('projects', () => {
  it('round-trips a project and announces it', async () => {
    const created = await project()

    expect(created).toMatchObject({ name: 'api', repoPath: '/srv/api' })
    expect(created.id).toMatch(/^prj_/)
    expect(created.createdAt).toBe(created.updatedAt)
    expect(seen.types()).toEqual(['project-changed'])
  })

  it('lists projects by name', async () => {
    await createProject({ name: 'web', repoPath: '/srv/web' })
    await createProject({ name: 'api', repoPath: '/srv/api' })

    await expect(listProjects().then(items => items.map(item => item.name))).resolves.toEqual(['api', 'web'])
  })

  it('is retired rather than deleted, and leaves its environments alone', async () => {
    const created = await project()
    await createDevEnvironmentRow({
      projectId: created.id,
      name: 'api',
      containerName: 'domo-dev-1',
      workspacePath: '/workspaces/api'
    })

    // Retiring takes the project off the live list and, unlike the hard delete
    // it replaced, does *not* cascade to its environments — nothing is removed,
    // so the `on delete cascade` never fires. Retiring each environment is
    // `retireProjectCascade`'s own job, and forgetting it would leave a live
    // environment under a retired project.
    await retireProjectRow(created.id)

    await expect(listProjects()).resolves.toEqual([])
    await expect(listDevEnvironments()).resolves.toEqual([
      expect.objectContaining({ name: 'api' })
    ])
    await expect(pruneRetiredProjects()).resolves.toBe(0)
  })
})

describe('dev environments', () => {
  it('starts out creating, with the columns the UI needs', async () => {
    const created = await project()
    const environment = await createDevEnvironmentRow({
      projectId: created.id,
      name: 'api',
      containerName: 'domo-dev-1',
      workspacePath: '/workspaces/api',
      configSource: 'domo',
      configPath: '.domo.json',
      remoteUser: 'vscode'
    })

    expect(environment).toMatchObject({
      status: 'creating',
      containerId: null,
      lastError: null,
      configSource: 'domo',
      remoteUser: 'vscode'
    })
    expect(seen.types()).toEqual(['project-changed', 'dev-environment-changed'])
  })

  it('patches only the columns it was given', async () => {
    const created = await project()
    const environment = await createDevEnvironmentRow({
      projectId: created.id,
      name: 'api',
      containerName: 'domo-dev-1',
      workspacePath: '/workspaces/api'
    })

    const updated = await updateDevEnvironment(environment.id, { status: 'running', containerId: 'sha' })

    expect(updated).toMatchObject({ status: 'running', containerId: 'sha', name: 'api' })
    expect(updated!.updatedAt >= environment.updatedAt).toBe(true)
  })

  it('returns null for an environment that is gone', async () => {
    await expect(updateDevEnvironment('env_nope', { status: 'running' })).resolves.toBeNull()
  })

  describe('ports', () => {
    let environmentId: string

    beforeEach(async () => {
      const created = await project()
      environmentId = (await createDevEnvironmentRow({
        projectId: created.id,
        name: 'api',
        containerName: 'domo-dev-1',
        workspacePath: '/workspaces/api'
      })).id
    })

    it('builds a loopback url for a forwarded tcp port', async () => {
      const port = await upsertDevEnvironmentPort({
        environmentId,
        innerPort: 3000,
        protocol: 'tcp',
        appProtocol: 'https',
        source: 'declared',
        hostPort: 54123,
        forwarded: true
      })

      expect(port.url).toBe('https://127.0.0.1:54123')
    })

    it('has no url until it is actually forwarded', async () => {
      const port = await upsertDevEnvironmentPort({
        environmentId,
        innerPort: 3000,
        protocol: 'tcp',
        source: 'detected'
      })

      expect(port).toMatchObject({ url: null, listening: false, forwarded: false })
    })

    it('keeps the same port number apart in the environment and in each service', async () => {
      const own = await upsertDevEnvironmentPort({ environmentId, innerPort: 3000, protocol: 'tcp', source: 'detected' })
      const web = await upsertDevEnvironmentPort({
        environmentId, service: 'stack-web-1', innerPort: 3000, protocol: 'tcp', source: 'detected'
      })
      await updateDevEnvironmentPort(environmentId, 3000, { hostPort: 54123, forwarded: true }, 'tcp', 'stack-web-1')

      expect(own.service).toBeNull()
      expect(web.service).toBe('stack-web-1')
      const ports = await listDevEnvironmentPorts(environmentId)
      expect(ports.map(port => [port.service, port.forwarded])).toEqual([[null, false], ['stack-web-1', true]])
    })

    it('never demotes a declared port to a detected one', async () => {
      await upsertDevEnvironmentPort({
        environmentId,
        innerPort: 3000,
        protocol: 'tcp',
        label: 'Web app',
        source: 'declared'
      })

      const port = await upsertDevEnvironmentPort({
        environmentId,
        innerPort: 3000,
        protocol: 'tcp',
        source: 'detected',
        listening: true
      })

      expect(port).toMatchObject({ source: 'declared', label: 'Web app', listening: true })
    })

    it('keeps a port forwarded once it has been forwarded', async () => {
      await upsertDevEnvironmentPort({
        environmentId,
        innerPort: 3000,
        protocol: 'tcp',
        source: 'detected',
        hostPort: 54123,
        forwarded: true
      })

      const port = await upsertDevEnvironmentPort({
        environmentId,
        innerPort: 3000,
        protocol: 'tcp',
        source: 'detected',
        listening: true
      })

      expect(port).toMatchObject({ forwarded: true, hostPort: 54123 })
    })

    it('treats the same port on tcp and udp as two ports', async () => {
      await upsertDevEnvironmentPort({ environmentId, innerPort: 5353, protocol: 'tcp', source: 'declared' })
      await upsertDevEnvironmentPort({ environmentId, innerPort: 5353, protocol: 'udp', source: 'declared' })

      await expect(listDevEnvironmentPorts(environmentId)).resolves.toHaveLength(2)
    })

    it('clears the host port when a forward is torn down', async () => {
      await upsertDevEnvironmentPort({
        environmentId,
        innerPort: 3000,
        protocol: 'tcp',
        source: 'detected',
        hostPort: 54123,
        forwarded: true
      })

      const port = await updateDevEnvironmentPort(environmentId, 3000, { hostPort: null, forwarded: false })

      expect(port).toMatchObject({ hostPort: null, forwarded: false, url: null })
    })
  })
})

describe('agent sessions', () => {
  it('takes a title from its first message only while it has none', async () => {
    const untitled = await agent({ adapter: 'claude-code', title: UNTITLED_AGENT_TITLE, cwd: '/srv/api', titlePlaceholder: true })
    expect(await titleUntitledAgentSession(untitled.id, 'Fix the login test')).toBe(true)
    expect(await titleUntitledAgentSession(untitled.id, 'Something later')).toBe(false)
    expect((await getAgentSession(untitled.id))!.title).toBe('Fix the login test')
    expect(seen.types()).toContain('agent-list-changed')
    // Somebody may call their session that, on purpose.
    const named = await agent({ adapter: 'claude-code', title: UNTITLED_AGENT_TITLE, cwd: '/srv/api' })
    expect(await titleUntitledAgentSession(named.id, 'Fix the login test')).toBe(false)
  })

  it('takes a generated title only while its title is a stand-in, which any rename ends', async () => {
    const standIn = await agent({ adapter: 'claude-code', title: 'fix the login test pls', cwd: '/srv/api', titlePlaceholder: true })
    expect(await nameAgentSession(standIn.id, 'Fix the login test')).toBe(true)
    expect(await nameAgentSession(standIn.id, 'Another')).toBe(false)
    expect((await getAgentSession(standIn.id))!.title).toBe('Fix the login test')

    const renamed = await agent({ adapter: 'claude-code', title: 'first words', cwd: '/srv/api', titlePlaceholder: true })
    await updateAgentSession(renamed.id, { title: 'Mine' })
    expect(await nameAgentSession(renamed.id, 'Generated')).toBe(false)
    expect((await getAgentSession(renamed.id))!.title).toBe('Mine')
  })

  it('starts in "starting", because a row exists before the adapter does', async () => {
    const session = await agent()

    expect(session).toMatchObject({ status: 'starting', adapter: 'claude-code', archived: false })
    expect(seen.types()).toEqual(['agent-list-changed'])
  })

  it('has no model until one is asked for, so the adapter picks', async () => {
    const session = await agent()

    expect(session.model).toBeNull()
  })

  it('round-trips the model it was created with, and what it later landed on', async () => {
    // The model is per session, so two agents can be on different ones at once.
    const session = await agent({
      adapter: 'claude-code', title: 'Auth refactor', cwd: '/srv/api', model: 'claude-haiku-4-5'
    })

    expect(session.model).toBe('claude-haiku-4-5')

    // The adapter reports what it actually resolved to; the row records that.
    const updated = await updateAgentSession(session.id, { model: 'haiku' })

    expect(updated!.model).toBe('haiku')
    await expect(getAgentSession(session.id).then(row => row!.model)).resolves.toBe('haiku')
  })

  it('lets the model be cleared back to the adapter\'s default', async () => {
    const session = await agent({
      adapter: 'codex', title: 'Docs', cwd: '/srv/api', model: 'gpt-5.6-luna'
    })

    await expect(updateAgentSession(session.id, { model: null }).then(row => row!.model)).resolves.toBeNull()
  })

  it('keeps an unknown adapter out of the domain type', async () => {
    await query(
      `insert into agent_sessions (id, adapter, title, cwd, created_at, updated_at)
       values ('ag_weird', 'gpt-42', 't', '/tmp', 'now', 'now')`
    )

    await expect(listAgentSessions().then(items => items[0]!.adapter)).resolves.toBe('claude-code')
  })

  it('stores modes as json and touches activity only when asked', async () => {
    const session = await agent()
    const modes = [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }]

    const updated = await updateAgentSession(session.id, { modes, modeId: 'plan' })

    expect(updated).toMatchObject({ modes, modeId: 'plan', lastActivityAt: null })
    expect(seen.types().slice(-2)).toEqual(['agent-changed', 'agent-list-changed'])

    const touched = await updateAgentSession(session.id, { status: 'thinking', touch: true })

    expect(touched!.lastActivityAt).toBeTruthy()
  })

  it('returns null for a session that is gone', async () => {
    await expect(updateAgentSession('ag_nope', { status: 'idle' })).resolves.toBeNull()
  })
})

describe('agent events', () => {
  it('appends an ordered, durable log and publishes each entry', async () => {
    const session = await agent()
    seen.clear()

    await appendAgentEvent(session.id, 'user_message', { content: [{ type: 'text', text: 'hi' }] })
    const last = await appendAgentEvent(session.id, 'turn_end', { stopReason: 'end_turn' })

    const events = await listAgentEvents(session.id)

    expect(events.map(event => event.type)).toEqual(['user_message', 'turn_end'])
    expect(events[0]!.payload).toEqual({ content: [{ type: 'text', text: 'hi' }] })
    expect(seen.events).toEqual([
      expect.objectContaining({ type: 'agent-event', agentSessionId: session.id }),
      expect.objectContaining({ type: 'agent-event', event: expect.objectContaining({ id: last.id }) })
    ])
  })

  it('serves the tail after a given seq, which is how a reconnect catches up', async () => {
    const session = await agent()
    const first = await appendAgentEvent(session.id, 'agent_message_chunk', {})
    await appendAgentEvent(session.id, 'agent_message_chunk', {})

    await expect(listAgentEvents(session.id, first.seq)).resolves.toHaveLength(1)
  })

  it('stores a null payload without turning it into a string', async () => {
    const session = await agent()
    const event = await appendAgentEvent(session.id, 'cancelled', undefined)

    expect(event.payload).toBeNull()
  })

  it('goes away with its session', async () => {
    const session = await agent()
    await appendAgentEvent(session.id, 'cancelled', null)

    await deleteAgentSession(session.id)

    await expect(query('select 1 from agent_events')).resolves.toEqual([])
  })
})

/**
 * Streaming text is the one thing in the log that is rewritten rather than
 * appended: one row per message block, grown in place. The row has to stay
 * where it was — same id, same `seq` — or the transcript reorders itself as the
 * agent talks.
 */
describe('streamed message blocks', () => {
  it('leaves exactly one row behind, however many deltas arrived', async () => {
    const session = await agent()
    let text = 'Look'
    const block = await openAgentStream(session.id, 'agent_message', text)
    for (const delta of ['ing ', 'at ', 'the ', 'build']) {
      text += delta
      await writeAgentStream(block.id, text, true)
    }
    await writeAgentStream(block.id, `${text}.`, false)

    const events = await listAgentEvents(session.id)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: block.id,
      seq: block.seq,
      type: 'agent_message',
      payload: { text: 'Looking at the build.', streaming: false },
      createdAt: block.createdAt
    })
  })

  it('shows the text so far to a reader who arrives mid-block', async () => {
    const session = await agent()
    const block = await openAgentStream(session.id, 'agent_message', 'Look')
    await writeAgentStream(block.id, 'Looking at', true)

    const [event] = await listAgentEvents(session.id)

    expect(event!.payload).toEqual({ text: 'Looking at', streaming: true })
  })

  it('publishes every rewrite, so the voice bar and the subscribers keep up', async () => {
    const session = await agent()
    seen.clear()
    const block = await openAgentStream(session.id, 'agent_thought', 'hm')
    await writeAgentStream(block.id, 'hmm', false)

    expect(seen.events).toEqual([
      expect.objectContaining({ type: 'agent-event', event: expect.objectContaining({ payload: { text: 'hm', streaming: true } }) }),
      expect.objectContaining({ type: 'agent-event', event: expect.objectContaining({ payload: { text: 'hmm', streaming: false } }) })
    ])
  })

  it('keeps a block in front of the tool call that interrupted it', async () => {
    const session = await agent()
    const first = await openAgentStream(session.id, 'agent_message', 'Let me look.')
    await appendAgentEvent(session.id, 'tool_call', { toolCallId: 'c1', title: 'Read' })
    const second = await openAgentStream(session.id, 'agent_message', 'Found it.')
    // The first block is still being finished while the tool call is already in.
    await writeAgentStream(first.id, 'Let me look.', false)

    const events = await listAgentEvents(session.id)

    expect(events.map(event => event.type)).toEqual(['agent_message', 'tool_call', 'agent_message'])
    expect(events.map(event => event.seq)).toEqual([...events.map(event => event.seq)].sort((a, b) => a - b))
    expect(events[2]!.id).toBe(second.id)
  })

  it('says so instead of inventing a row when the block is gone', async () => {
    await expect(writeAgentStream('ev_nope', 'orphan', false)).resolves.toBeNull()
  })
})

describe('permissions', () => {
  const options = [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]

  async function pending(agentSessionId: string) {
    return createPermission({
      agentSessionId,
      toolCallId: 'call_1',
      title: 'Run `pnpm test`',
      options,
      toolCall: { title: 'Bash', rawInput: { command: 'pnpm test' } }
    })
  }

  it('is a row, not a callback: it survives whatever asked for it', async () => {
    const session = await agent()
    const permission = await pending(session.id)

    expect(permission).toMatchObject({ resolvedAt: null, resolvedBy: null, options })
    await expect(listPermissions(session.id)).resolves.toHaveLength(1)
  })

  it('records who answered it, once', async () => {
    const session = await agent()
    const permission = await pending(session.id)

    await expect(resolvePermissionRow(permission.id, 'allow', 'agent:ag_parent')).resolves.toMatchObject({
      resolvedOptionId: 'allow',
      resolvedBy: 'agent:ag_parent'
    })
    // The UI, a spawning agent and auto-approve all race for the same row.
    await expect(resolvePermissionRow(permission.id, 'deny', 'user')).resolves.toBeNull()
  })

  it('drops out of the pending list once answered, but is still on the record', async () => {
    const session = await agent()
    const permission = await pending(session.id)
    await resolvePermissionRow(permission.id, 'allow', 'user')

    await expect(listPermissions(session.id)).resolves.toEqual([])
    await expect(listPermissions(session.id, false)).resolves.toHaveLength(1)
  })

  it('lists pending requests across every agent', async () => {
    const first = await agent()
    const second = await agent({ adapter: 'codex', title: 'Docs', cwd: '/srv/api' })
    await pending(first.id)
    await pending(second.id)

    await expect(listPermissions()).resolves.toHaveLength(2)
  })

  it('announces both the request and the answer', async () => {
    const session = await agent()
    seen.clear()
    const permission = await pending(session.id)
    await resolvePermissionRow(permission.id, 'allow', 'user')

    expect(seen.types()).toEqual(['permission-changed', 'permission-changed'])
  })
})

describe('the agent inbox', () => {
  const said = (text: string) => [{ type: 'text', text }]

  async function queued(agentSessionId: string, text: string) {
    return enqueueInboxMessage({ agentSessionId, content: said(text), delivery: 'queue', origin: 'user' })
  }

  it('is a row, so a message that could not be delivered is not lost', async () => {
    const session = await agent()

    const message = await queued(session.id, 'then push it')

    expect(message).toMatchObject({
      agentSessionId: session.id,
      content: said('then push it'),
      delivery: 'queue',
      origin: 'user',
      deliveredAt: null
    })
    await expect(listInboxMessages(session.id)).resolves.toHaveLength(1)
  })

  /**
   * Everything at once, in `seq` order: the drain answers the whole queue in
   * one turn, so a claim that handed over the oldest row and left the rest
   * would be a turn per message again.
   */
  it('hands over everything that is waiting, oldest first', async () => {
    const session = await agent()
    await queued(session.id, 'first')
    await queued(session.id, 'second')

    await expect(claimInboxMessages(session.id)).resolves.toMatchObject([
      { content: said('first') },
      { content: said('second') }
    ])
    await expect(claimInboxMessages(session.id)).resolves.toEqual([])
  })

  it('marks a claimed message delivered, so no drain can hand it over twice', async () => {
    const session = await agent()
    await queued(session.id, 'only once')

    const [claimed] = await claimInboxMessages(session.id)

    expect(claimed!.deliveredAt).toEqual(expect.any(String))
    await expect(listInboxMessages(session.id)).resolves.toEqual([])
    await expect(listInboxMessages(session.id, false)).resolves.toHaveLength(1)
  })

  it('keeps each agent\'s queue to itself', async () => {
    const first = await agent()
    const second = await agent({ adapter: 'codex', title: 'Docs', cwd: '/srv/api' })
    await queued(first.id, 'for the first')

    await expect(claimInboxMessages(second.id)).resolves.toEqual([])
    await expect(listInboxMessages(first.id)).resolves.toHaveLength(1)
  })

  it('can be taken back before it goes out, and not after', async () => {
    const session = await agent()
    const message = await queued(session.id, 'never mind')

    await expect(deleteInboxMessage(message.id)).resolves.toMatchObject({ id: message.id })
    await expect(deleteInboxMessage(message.id)).resolves.toBeNull()

    const delivered = await queued(session.id, 'too late')
    await claimInboxMessages(session.id)
    await expect(deleteInboxMessage(delivered.id)).resolves.toBeNull()
  })

  it('announces every change, so the panel never polls', async () => {
    const session = await agent()
    seen.clear()
    const message = await queued(session.id, 'watch this')
    await claimInboxMessages(session.id)
    await queued(session.id, 'and this')
    await deleteInboxMessage(message.id)

    // enqueue, claim, enqueue — the delete of an already-delivered row is not
    // a change and says nothing.
    expect(seen.types()).toEqual([
      'agent-inbox-changed', 'agent-inbox-changed', 'agent-inbox-changed'
    ])
  })

  it('puts claimed messages back under the same ids, in order', async () => {
    const session = await agent()
    const first = await queued(session.id, 'first')
    const second = await queued(session.id, 'second')

    await releaseInboxMessages(await claimInboxMessages(session.id))

    // A watch on a message is keyed by its id, so a copy would orphan it.
    await expect(listInboxMessages(session.id)).resolves.toMatchObject([{ id: first.id }, { id: second.id }])
  })

  it('holds a restart while a message is about to reach an agent, but not for ever', async () => {
    const session = await agent()
    await updateAgentSession(session.id, { status: 'idle' })
    const now = new Date()
    await queued(session.id, 'about to go')

    await expect(restartBlockers(now)).resolves.toEqual(['a message is about to reach an agent'])
    // Stuck on a session that cannot take it: no reason to never update.
    await expect(restartBlockers(new Date(now.getTime() + 3 * 60_000))).resolves.toEqual([])
    await claimInboxMessages(session.id)
    await expect(restartBlockers(now)).resolves.toEqual([])
  })

  it('goes away with the session it was queued for', async () => {
    const session = await agent()
    await queued(session.id, 'pending')

    await deleteAgentSession(session.id)

    await expect(listInboxMessages(session.id, false)).resolves.toEqual([])
  })
})

describe('subscriptions between agents', () => {
  it('records who is following whom, and only once', async () => {
    const watcher = await agent()
    const target = await agent({ adapter: 'codex', title: 'Docs', cwd: '/srv/api' })

    await addAgentSubscription(watcher.id, target.id)
    await addAgentSubscription(watcher.id, target.id)

    await expect(listAgentSubscribers(target.id)).resolves.toEqual([watcher.id])
    await expect(listAgentSubscriptions(watcher.id)).resolves.toMatchObject([
      { subscriberId: watcher.id, targetId: target.id }
    ])
  })

  it('says whether there was anything to remove', async () => {
    const watcher = await agent()
    const target = await agent({ adapter: 'codex', title: 'Docs', cwd: '/srv/api' })
    await addAgentSubscription(watcher.id, target.id)

    await expect(removeAgentSubscription(watcher.id, target.id)).resolves.toBe(true)
    await expect(removeAgentSubscription(watcher.id, target.id)).resolves.toBe(false)
  })

  it('goes away with the session on either end of it', async () => {
    const watcher = await agent()
    const target = await agent({ adapter: 'codex', title: 'Docs', cwd: '/srv/api' })
    await addAgentSubscription(watcher.id, target.id)

    await deleteAgentSession(target.id)

    await expect(listAgentSubscriptions(watcher.id)).resolves.toEqual([])
  })
})

describe('watches on a message', () => {
  const follows = async (subscriberId: string) =>
    (await listAgentSubscriptions(subscriberId)).map(entry => [entry.targetId, entry.remainingTurns])

  it('become one subscription per sender when the message is answered, merged with what it held', async () => {
    const sender = await agent()
    const other = await agent({ adapter: 'codex', title: 'Other', cwd: '/srv/api' })
    const target = await agent({ adapter: 'codex', title: 'Docs', cwd: '/srv/api' })
    await addAgentSubscription(sender.id, target.id, 3)
    await addMessageWatch({ messageId: 'in_a', subscriberId: sender.id, targetId: target.id, remainingTurns: 1 })
    await addMessageWatch({ messageId: 'in_b', subscriberId: sender.id, targetId: target.id, remainingTurns: 2 })
    await addMessageWatch({ messageId: 'in_c', subscriberId: other.id, targetId: target.id, remainingTurns: null })
    await addMessageWatch({ messageId: 'in_later', subscriberId: other.id, targetId: target.id, remainingTurns: 1 })

    const armed = await armMessageWatches(target.id, ['in_a', 'in_b', 'in_c'])

    expect(armed.sort()).toEqual([sender.id, other.id].sort())
    // The longer window wins; it does not add up, and it does not shrink.
    await expect(follows(sender.id)).resolves.toEqual([[target.id, 3]])
    await expect(follows(other.id)).resolves.toEqual([[target.id, null]])
    // Not answered yet, so still only waiting.
    expect(await query('select message_id from agent_message_watches')).toEqual([{ message_id: 'in_later' }])
  })

  it('never makes an agent follow itself', async () => {
    const target = await agent()
    await addMessageWatch({ messageId: 'in_self', subscriberId: target.id, targetId: target.id, remainingTurns: 1 })

    await expect(armMessageWatches(target.id, ['in_self'])).resolves.toEqual([])
    await expect(listAgentSubscriptions(target.id)).resolves.toEqual([])
  })

  it('goes when the message is withdrawn', async () => {
    const sender = await agent()
    const target = await agent({ adapter: 'codex', title: 'Docs', cwd: '/srv/api' })
    const message = await enqueueInboxMessage({ agentSessionId: target.id, content: [], delivery: 'queue', origin: `agent:${sender.id}` })
    await addMessageWatch({ messageId: message.id, subscriberId: sender.id, targetId: target.id, remainingTurns: 1 })

    await deleteInboxMessage(message.id)

    expect(await query('select * from agent_message_watches')).toEqual([])
  })
})

describe('the latest thing an agent said', () => {
  it('is the last message block, which is what a subscriber is told', async () => {
    const session = await agent()
    await appendAgentEvent(session.id, 'agent_message', { text: 'Looking at it.', streaming: false })
    await appendAgentEvent(session.id, 'tool_call', { title: 'Bash' })
    await appendAgentEvent(session.id, 'agent_message', { text: 'Fixed the build.', streaming: false })

    await expect(latestAgentMessage(session.id)).resolves.toBe('Fixed the build.')
  })

  it('is empty for an agent that has not said anything', async () => {
    await expect(latestAgentMessage((await agent()).id)).resolves.toBe('')
  })
})

describe('mcp servers', () => {
  it('defaults a new server to enabled', async () => {
    const server = await createMcpServer({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app' })

    expect(server).toMatchObject({ enabled: true, args: [], env: {}, headers: {} })
    expect(seen.types()).toEqual(['mcp-changed'])
  })

  it('round-trips the json columns of a stdio server', async () => {
    const server = await createMcpServer({
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv'],
      env: { ROOT: '/srv' }
    })

    await expect(listMcpServers().then(items => items[0])).resolves.toMatchObject({
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv'],
      env: { ROOT: '/srv' }
    })
    expect(server.command).toBe('npx')
  })

  it('patches without clearing the columns it was not given', async () => {
    const server = await createMcpServer({ name: 'linear', transport: 'http', url: 'https://mcp.linear.app' })

    const updated = await updateMcpServer(server.id, { enabled: false })

    expect(updated).toMatchObject({ enabled: false, url: 'https://mcp.linear.app', name: 'linear' })
  })

  it('returns null for a server that is gone', async () => {
    await expect(updateMcpServer('mcp_nope', { enabled: false })).resolves.toBeNull()
  })
})
