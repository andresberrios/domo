import { rm } from 'node:fs/promises'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AgentAdapter, DevEnvironment } from '~~/shared/types'
import {
  assistantText,
  eventsOfType,
  fixtureRepo,
  PREFIX,
  startMeshServer,
  type MeshHarness
} from './helpers'

/**
 * Both coding agents, for real, inside a real development environment.
 *
 * This is the boundary every other layer stops at: a real account, a real
 * adapter process, a real container, real Postgres. `acp-stream.spec.ts` proves
 * the runtime handles what an adapter *says*; only this can say the adapter
 * says it — that `session/new` succeeds through `docker exec`, that a tool call
 * really writes a file in the workspace volume, that a permission really comes
 * back as a row, and that the mesh is reachable from inside the container.
 *
 * Opt in: `pnpm test:agents`. Minutes on a cold environment build.
 */

const HOUR = 60 * 60 * 1000

/** The cheapest model each adapter offers, read off a real `session/new`. */
const MODELS: Record<AgentAdapter, string> = {
  // "Haiku 4.5 · Fastest for quick answers". The adapter lists `haiku`, not a
  // dated id; the resolver accepts either.
  'claude-code': 'haiku',
  // "Fast and affordable agentic coding model" — codex-acp lists no *-mini or
  // *-nano id at all, and luna is the cheap end of the 5.6 family.
  codex: 'gpt-5.6-luna',
  opencode: 'opencode-go/kimi-k3'
}

let mesh: MeshHarness
let environment: DevEnvironment
let repoPath = ''
/** A second checkout, for the host sessions that have no environment. */
let hostCwd = ''
const sessions: string[] = []

async function docker(...args: string[]): Promise<string> {
  const { run } = await import('../../server/lib/dev-env/docker')
  return (await run('docker', args, { allowFailure: true }).catch(() => ({ stdout: '' }))).stdout
}

beforeAll(async () => {
  process.env.NUXT_DEV_ENV_RESOURCE_PREFIX = PREFIX
  // Never the developer's own Claude config: the environment gets a copy of
  // whatever this points at, and an empty directory keeps the test hermetic.
  process.env.NUXT_CLAUDE_CONFIG_DIR = '/nonexistent-domo-agents-test'

  mesh = await startMeshServer()
  // `internalBaseUrl(true)` rewrites a loopback host to `host.docker.internal`,
  // which is how the container reaches this process.
  process.env.NUXT_INTERNAL_URL = `http://127.0.0.1:${mesh.port}`

  const { createProject } = await import('../../server/lib/repo')
  const { createEnvironment } = await import('../../server/lib/dev-environments')

  repoPath = await fixtureRepo()
  hostCwd = await fixtureRepo()
  const project = await createProject({ name: 'agents-live', repoPath })
  environment = await createEnvironment({ projectId: project.id, name: 'Agents Live' })
  expect(environment.status).toBe('running')
}, HOUR)

afterAll(async () => {
  const { acpManager } = await import('../../server/lib/acp/manager')
  const { removeEnvironment } = await import('../../server/lib/dev-environments')

  // Cancel before killing, so a turn in flight does not leave the adapter
  // holding an open request the container never answers.
  for (const id of sessions) {
    await acpManager.cancel(id).catch(() => {})
    acpManager.stop(id)
  }
  if (environment) await removeEnvironment(environment.id).catch(() => {})
  await mesh?.close()
  for (const path of [repoPath, hostCwd]) {
    if (path) await rm(path, { recursive: true, force: true })
  }

  delete process.env.NUXT_DEV_ENV_RESOURCE_PREFIX
  delete process.env.NUXT_CLAUDE_CONFIG_DIR
  delete process.env.NUXT_INTERNAL_URL
}, HOUR)

/**
 * What actually makes each adapter ask permission. All of it measured, none of
 * it assumed — and the two are not the same.
 *
 * Claude Code's default mode ("Manual") already asks, but only for its *own*
 * tools: Domo advertises `fs/writeTextFile`, and a write the adapter delegates
 * to the client raises nothing, because the client is doing it. A shell command
 * is the one it always asks about.
 *
 * codex-acp starts in `agent` ("Approve for me") and asks for nothing at all;
 * `read-only` ("Ask for approval") is the mode that does, and there it asks to
 * edit files rather than about the command that would edit them.
 */
const ASKS: Record<AgentAdapter, { modeId: string, prompt: string }> = {
  'claude-code': {
    modeId: 'default',
    prompt: 'Run this exact shell command with your shell tool, and nothing else: '
      + 'echo ok > permission-probe.txt'
  },
  codex: {
    modeId: 'read-only',
    prompt: 'Create a file named permission-probe.txt containing the word ok.'
  },
  opencode: {
    modeId: 'plan',
    prompt: 'Create a file named permission-probe.txt containing the word ok.'
  }
}

/** Start a session in the shared environment, on the cheap model. */
async function start(adapter: AgentAdapter, options: { modeId?: string, host?: boolean } = {}) {
  const { acpManager } = await import('../../server/lib/acp/manager')
  const session = await acpManager.create({
    adapter,
    title: `live ${adapter}`,
    devEnvironmentId: options.host ? null : environment.id,
    cwd: options.host ? hostCwd : undefined,
    modeId: options.modeId,
    model: MODELS[adapter]
  })
  sessions.push(session.id)
  // `create` swallows a boot failure onto the row so the UI can show it; here
  // that would be a green test with no agent in it.
  expect(session.status, `${adapter} failed to start: ${session.lastError}`).not.toBe('error')
  return session
}

describe.each<AgentAdapter>(['codex', 'claude-code'])('%s in a dev environment', (adapter) => {
  it('starts a session inside the container, on the model it was given', async () => {
    const { getAgentSession } = await import('../../server/lib/repo')
    const session = await start(adapter)

    const row = (await getAgentSession(session.id))!
    expect(row.acpSessionId, 'the ACP session id is recorded').toBeTruthy()
    expect(row.devEnvironmentId).toBe(environment.id)
    expect(row.cwd).toBe(environment.workspacePath)
    expect(['idle', 'running', 'thinking']).toContain(row.status)

    // The model is what the adapter said it landed on, not what was asked for.
    expect(row.model).toBe(MODELS[adapter])
    const recorded = await eventsOfType(session.id, 'model_changed')
    expect(recorded[0]?.payload).toMatchObject({ modelId: MODELS[adapter] })
  }, HOUR / 4)

  it('writes a file in the workspace, streaming the turn into agent_events', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { readEnvironmentFile } = await import('../../server/lib/dev-environments')
    const session = await start(adapter)

    const expected = `hello from ${adapter}`
    const turn = acpManager.prompt(session.id, [{
      type: 'text',
      text: `Create a file named hello.txt containing exactly: ${expected}\n`
        + 'Then read it back and reply with its contents.'
    }])

    // Auto-approve is off, so the write raises a permission row the test has to
    // answer before the turn can finish. Some adapters/modes do not ask at all,
    // which is what `askedForPermission` below records.
    const answered = answerPermissions(session.id)
    const result = await turn
    const asked = await answered.stop()

    expect(result.stopReason).toBe('end_turn')

    const file = await readEnvironmentFile(environment, `${environment.workspacePath}/hello.txt`)
    expect(file.trim()).toBe(expected)

    const text = await assistantText(session.id)
    expect(text).toContain(expected)
    // One row per block, rewritten in place — never one per delta.
    expect((await eventsOfType(session.id, 'agent_message_chunk'))).toHaveLength(0)
    expect((await eventsOfType(session.id, 'agent_message')).length).toBeGreaterThan(0)
    expect((await eventsOfType(session.id, 'tool_call')).length).toBeGreaterThan(0)
    expect((await eventsOfType(session.id, 'turn_end'))[0]?.payload)
      .toMatchObject({ stopReason: 'end_turn' })

    // Not an assertion: what each adapter asks for by default is a finding.
    console.log(`[${adapter}] permissions asked for by default: ${asked.length ? asked.join(', ') : '(none)'}`)
  }, HOUR / 4)

  it('raises a permission as a row, and waits for the answer', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { listPermissions } = await import('../../server/lib/repo')
    // Auto-approve is off (the default), so nothing resolves this but the test.
    const { modeId, prompt } = ASKS[adapter]
    const session = await start(adapter, { modeId })

    const turn = acpManager.prompt(session.id, [{ type: 'text', text: prompt }])
    const answered = answerPermissions(session.id)
    await turn
    const asked = await answered.stop()

    expect(asked.length, `${adapter} in mode ${modeId} asked for no permission`).toBeGreaterThan(0)

    // Resolved in the database, by the user, and gone from the pending list.
    const resolved = await listPermissions(session.id, false)
    expect(resolved.length).toBeGreaterThan(0)
    expect(resolved[0]).toMatchObject({ resolvedBy: 'user' })
    expect(resolved[0]!.resolvedOptionId).toBeTruthy()
    await expect(listPermissions(session.id)).resolves.toEqual([])

    expect((await eventsOfType(session.id, 'permission_request')).length).toBeGreaterThan(0)
    console.log(`[${adapter}] asked permission for: ${asked.join(', ')}`)
  }, HOUR / 4)

  // The same turn without a container, so a regression can be attributed to one
  // or the other rather than to "agents".
  it('does the same on the host, outside any environment', async () => {
    const { readFile } = await import('node:fs/promises')
    const { acpManager } = await import('../../server/lib/acp/manager')
    const session = await start(adapter, { host: true })

    const expected = `hello from host ${adapter}`
    const turn = acpManager.prompt(session.id, [{
      type: 'text',
      text: `Create a file named host.txt containing exactly: ${expected}\n`
        + 'Then read it back and reply with its contents.'
    }])
    const answered = answerPermissions(session.id)
    const result = await turn
    await answered.stop()

    expect(result.stopReason).toBe('end_turn')
    await expect(readFile(`${hostCwd}/host.txt`, 'utf8')).resolves.toContain(expected)
    expect(await assistantText(session.id)).toContain(expected)
  }, HOUR / 4)

  it('reaches Domo\'s mesh from inside the container, authenticated as itself', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { verifyMeshToken } = await import('../../server/lib/mesh/token')
    const session = await start(adapter)
    const before = mesh.calls.length

    const answered = answerPermissions(session.id)
    await acpManager.prompt(session.id, [{
      type: 'text',
      text: 'Call the `list_agents` tool from the domo MCP server '
        + 'and reply with the number of agents it returned.'
    }])
    await answered.stop()

    const calls = mesh.calls.slice(before)
    const toolCall = calls.find(call => call.method === 'tools/call' && call.toolName === 'list_agents')
    expect(toolCall, `the mesh saw no list_agents call; it saw: ${calls.map(c => c.method).join(', ')}`)
      .toBeTruthy()
    // The bearer is the calling session's own token, minted in this process.
    expect(verifyMeshToken(toolCall!.authorization.replace(/^Bearer\s+/i, ''))).toBe(session.id)
  }, HOUR / 4)
})

/**
 * Answer every permission this session raises, allowing it, and report what was
 * asked. Runs alongside a turn: `prompt()` does not resolve until the adapter's
 * request has been answered, so nothing can poll for it afterwards.
 */
function answerPermissions(agentSessionId: string) {
  const asked: string[] = []
  let running = true
  const loop = (async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { listPermissions } = await import('../../server/lib/repo')
    while (running) {
      for (const pending of await listPermissions(agentSessionId).catch(() => [])) {
        const allow = pending.options.find(option => option.kind === 'allow_once')
          ?? pending.options.find(option => option.kind === 'allow_always')
          ?? pending.options[0]
        if (!allow) continue
        asked.push(pending.title)
        await acpManager.answerPermission(agentSessionId, pending.id, allow.optionId, 'user')
      }
      await new Promise(wait => setTimeout(wait, 250))
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
      return asked
    }
  }
}

describe('cleanup', () => {
  it('leaves no container, volume or image behind', async () => {
    const { removeEnvironment } = await import('../../server/lib/dev-environments')
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { workspaceVolumeName } = await import('../../server/lib/dev-environments')
    const { environmentImageName } = await import('../../server/lib/dev-env/image')

    for (const id of sessions.splice(0)) {
      await acpManager.cancel(id).catch(() => {})
      acpManager.stop(id)
    }
    const id = environment.id
    await removeEnvironment(id)
    environment = null as any

    expect(await docker('ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`)).toBe('')
    expect(await docker('volume', 'ls', '--quiet', '--filter', `name=^${workspaceVolumeName(id)}$`)).toBe('')
    expect(await docker('images', '--quiet', environmentImageName(id))).toBe('')
    // The shared runtime volume is deliberately kept: it is the expensive part.
  }, HOUR / 4)
})
