import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentAdapter, DevEnvironment } from '~~/shared/types'
import { removeCachedImages } from '../helpers/cached-images'
import {
  assistantText,
  events,
  eventsOfType,
  fixtureRepo,
  PREFIX,
  PROBE_MARKER,
  startMeshServer,
  type MeshHarness
} from './helpers'

/**
 * Every coding agent, for real, inside a real development environment.
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
  // "Haiku 5.5 · Fastest for quick answers". The adapter lists `haiku`, not a
  // dated id; the resolver accepts either.
  'claude-code': 'haiku',
  // "Older fast and efficient model" — codex-acp lists no *-mini or
  // *-nano id at all, and luna is the cheap end of the 5.6 family.
  codex: 'gpt-5.6-luna',
  // Exact, and it has to be: with a key set the adapter lists `opencode/*` and
  // `opencode-go/*` together and 18 bare names are in both, so a preference
  // like `glm-5.3` is refused as ambiguous rather than guessed at. The `-go`
  // provider is the flat subscription; `flash` is the cheap end of it.
  opencode: 'opencode-go/glm-5.3-flash',
  // The router, which every plan offers; Copilot Free offers nothing else.
  copilot: 'auto',
  // Grok lists two models, both large; the older one, at its lowest effort.
  grok: 'grok-4.5'
}

/** A second cheap model per adapter, for the switch. */
const OTHER_MODELS: Record<AgentAdapter, string> = {
  'claude-code': 'sonnet',
  codex: 'gpt-6-luna',
  opencode: 'opencode-go/gpt-5.6-luna',
  // Free on paid plans' request billing. Copilot Free refuses it; see the switch test.
  copilot: 'gpt-5-mini',
  grok: 'grok-4.6'
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
  environment = await createEnvironment({ projectId: project.id, name: 'agents-live' })
  expect(environment.status).toBe('running')

  // OpenCode's prompts are governed by a Domo setting whose default is
  // deliberately permissive for environments. Pin it to `ask` so these tests
  // describe the *adapter* and keep saying the same thing whatever that default
  // becomes; the one test that is about the setting flips it itself.
  const { patchSettings } = await import('../../server/lib/settings')
  await patchSettings({ openCodePermission: { host: 'ask', environment: 'ask' } })
}, HOUR)

afterAll(async () => {
  const { acpManager } = await import('../../server/lib/acp/manager')
  const { retireEnvironment } = await import('../../server/lib/dev-environments')

  // Cancel before killing, so a turn in flight does not leave the adapter
  // holding an open request the container never answers.
  for (const id of sessions) {
    await acpManager.cancel(id).catch(() => {})
    acpManager.stop(id)
  }
  if (environment) await retireEnvironment(environment.id).catch(() => {})
  await removeCachedImages(PREFIX)
  // Shared by this run's environments only; the runtime and browser volumes are kept for the next run.
  const { sharedCacheVolumeName } = await import('../../server/lib/dev-env/caches')
  await docker('volume', 'rm', sharedCacheVolumeName())
  await mesh?.close()
  for (const path of [repoPath, hostCwd]) {
    if (path) await rm(dirname(path), { recursive: true, force: true })
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
 * codex-acp starts in `agent` ("Auto review") and asks for nothing at all;
 * `read-only` is the mode that does. Since codex-acp 2.0 it is really read-only,
 * and it asks to run the command and to read, not to edit.
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
  // Measured, and it is neither a command nor an edit: OpenCode asks when a
  // tool touches a path *outside* the session's working directory. An in-`cwd`
  // write raises nothing at all.
  opencode: {
    modeId: 'build',
    prompt: 'Read the file /etc/hosts with your read tool and reply with its first line.'
  },
  // Copilot's Agent mode with Allow All off asks before every shell command.
  copilot: {
    modeId: 'https://agentclientprotocol.com/protocol/session-modes#agent',
    prompt: 'Run this exact shell command with your shell tool, and nothing else: '
      + 'echo ok > permission-probe.txt'
  },
  // Grok's default mode runs reads without asking and asks before a command that writes.
  grok: {
    modeId: 'default',
    prompt: 'Run this exact shell command with your shell tool, and nothing else: '
      + 'echo ok > permission-probe.txt'
  }
}

/**
 * Whether the adapter names the tool in its ACP `tool_call` event.
 *
 * Claude Code and Codex do. OpenCode does not — an MCP call arrives as
 * `title: "execute"`, `kind: "other"`, `rawInput: {}`, with the tool's own name
 * nowhere in the payload, so anything asserting on the name is measuring the
 * adapter's reporting format rather than what the tool did. The behaviour
 * assertions either side of this are adapter-neutral and are the ones that
 * matter.
 */
const NAMES_TOOL_CALLS: Record<AgentAdapter, boolean> = {
  'claude-code': true,
  codex: true,
  opencode: false,
  copilot: true,
  grok: true
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

describe.each<AgentAdapter>(['codex', 'claude-code', 'opencode', 'copilot', 'grok'])('%s in a dev environment', (adapter) => {
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

    // Domo answers nothing itself, so the write raises a permission row the test has to
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
    // Domo answers nothing itself, so nothing resolves this but the test.
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

  it('drives the headless browser from inside the container', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const session = await start(adapter)
    const before = mesh.pageHits.length
    // Same process, reached the same way the mesh is.
    const url = `http://host.docker.internal:${mesh.port}/probe`

    const answered = answerPermissions(session.id)
    const result = await acpManager.prompt(session.id, [{
      type: 'text',
      text: `Use the \`browser_navigate\` tool from the browser MCP server to open ${url}, `
        + 'then call `browser_snapshot`, and reply with the heading text you find on the page.'
    }])
    await answered.stop()

    expect(result.stopReason).toBe('end_turn')

    // The strongest signal there is: a real Chromium in the container actually
    // fetched the page. Nothing else in this process can produce this hit.
    expect(
      mesh.pageHits.slice(before).length,
      'nothing fetched the probe page, so no browser ran in the container'
    ).toBeGreaterThan(0)

    // …and it came back through the browser rather than by some other route:
    // the marker is only in the rendered page.
    expect(await assistantText(session.id)).toContain(PROBE_MARKER)

    // Which tool was called is only assertable on an adapter that says.
    // OpenCode reports every MCP tool call as `title: "execute"`, `kind:
    // "other"`, `rawInput: {}` — the tool's own name appears nowhere in the
    // ACP event, so this regex cannot pass for it however well the browser
    // works. Measured against a purpose-built stdio MCP server: OpenCode
    // spawned it, sent `initialize`, `tools/list` and `tools/call`, and the
    // result came back — reported as `execute` throughout.
    if (NAMES_TOOL_CALLS[adapter]) {
      const toolNames = (await eventsOfType(session.id, 'tool_call'))
        .map(event => JSON.stringify(event.payload))
        .join(' ')
      expect(toolNames, 'no browser tool call was recorded').toMatch(/browser_/)
    }
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

  // Codex runs every command in its own sandbox, which needs a user namespace
  // inside the container. When it cannot make one, every command fails, and in
  // `read-only` the agent asks to run it outside the sandbox instead: asking is
  // the symptom, not the feature.
  it.runIf(adapter === 'codex')('runs a read in its sandbox without asking, in read-only', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const session = await start(adapter, { modeId: 'read-only' })

    const answered = answerPermissions(session.id)
    const result = await acpManager.prompt(session.id, [{
      type: 'text',
      text: 'Run the shell command `cat README.md` with your shell tool and reply with its first line exactly.'
    }])
    const asked = await answered.stop()

    expect(result.stopReason).toBe('end_turn')
    expect(await assistantText(session.id)).toContain('# fixture')
    expect(asked, 'Codex asked to leave its sandbox for a read').toEqual([])
  }, HOUR / 4)

  it('switches model on a live session, and runs the next turn on it', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { getAgentSession } = await import('../../server/lib/repo')
    const session = await start(adapter)
    await acpManager.prompt(session.id, [{ type: 'text', text: 'Reply with the single word ONE.' }])

    // Copilot Free offers Auto alone (its picker lists no model), so there the
    // switch is refused, naming what is on offer, and the session stays put.
    if (adapter === 'copilot') {
      const { listAdapterModels } = await import('../../server/lib/acp/models')
      const offered = (await listAdapterModels('copilot')).models.map(model => model.id)
      if (!offered.includes(OTHER_MODELS.copilot)) {
        expect(offered).toEqual(['auto'])
        await expect(acpManager.setModel(session.id, OTHER_MODELS.copilot)).rejects.toThrow(/does not offer.*auto/s)
        expect((await getAgentSession(session.id))!.model).toBe('auto')
        return
      }
    }

    await acpManager.setModel(session.id, OTHER_MODELS[adapter])

    expect((await getAgentSession(session.id))!.model).toBe(OTHER_MODELS[adapter])
    expect((await eventsOfType(session.id, 'model_changed')).at(-1)?.payload)
      .toMatchObject({ modelId: OTHER_MODELS[adapter] })
    const result = await acpManager.prompt(session.id, [{ type: 'text', text: 'Reply with the single word TWO.' }])
    expect(result.stopReason).toBe('end_turn')
    expect(await assistantText(session.id)).toMatch(/TWO/i)
  }, HOUR / 4)

  // Every restart of Domo, and every Nitro reload under `pnpm dev`, reattaches
  // a session through `session/load` inside the container.
  it('picks the conversation back up after its adapter restarts', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { getAgentSession } = await import('../../server/lib/repo')
    const session = await start(adapter, { modeId: ASKS[adapter].modeId })
    const codeword = `kumquat-${Math.random().toString(36).slice(2, 7)}`
    await acpManager.prompt(session.id, [{ type: 'text', text: `The codeword is ${codeword}. Reply with OK only.` }])

    acpManager.stop(session.id)
    await vi.waitFor(() => expect(acpManager.isRunning(session.id)).toBe(false))
    const answered = answerPermissions(session.id)
    const result = await acpManager.prompt(session.id, [{
      type: 'text',
      // Named by its prefix: Copilot Free's small model otherwise echoes the last "OK".
      text: 'What was the codeword I gave you? It starts with kumquat-. Reply with the whole codeword only.'
    }])
    await answered.stop()

    expect(result.stopReason).toBe('end_turn')
    expect(await assistantText(session.id)).toContain(codeword)
    // The row's choices are put back on the reloaded session.
    expect(await getAgentSession(session.id)).toMatchObject({
      model: MODELS[adapter],
      modeId: ASKS[adapter].modeId
    })
  }, HOUR / 4)

  it('takes a message mid-turn: steered where the adapter can be, then one queued behind it', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { getAgentSession, listInboxMessages } = await import('../../server/lib/repo')
    const session = await start(adapter)
    const answered = answerPermissions(session.id)

    const first = acpManager.prompt(session.id, [{
      type: 'text',
      text: 'Run the shell command `sleep 8` with your shell tool, then reply with the word FIRST.'
    }]).catch(() => ({ stopReason: 'failed' }))
    await vi.waitFor(async () => expect((await eventsOfType(session.id, 'tool_call')).length).toBeGreaterThan(0), { timeout: 120_000, interval: 250 })

    const steered = await acpManager.deliver(session.id, {
      content: [{ type: 'text', text: 'Also end your reply with the word STEERED.' }],
      delivery: 'steer'
    })
    const queued = await acpManager.deliver(session.id, {
      content: [{ type: 'text', text: 'Reply with the single word QUEUED.' }],
      delivery: 'queue'
    })
    await first
    await vi.waitFor(async () => {
      expect(await listInboxMessages(session.id)).toEqual([])
      expect(acpManager.isBusy(session.id)).toBe(false)
      expect((await getAgentSession(session.id))!.status).toBe('idle')
    }, { timeout: 240_000, interval: 500 })
    await answered.stop()

    // OpenCode cannot be steered, so a steer interrupts it instead.
    expect(steered.outcome).toBe(acpManager.supportsSteering(session.id) ? 'steered' : 'prompted')
    expect(queued.outcome).toBe('queued')
    const text = await assistantText(session.id)
    expect(text).toMatch(/STEERED/)
    expect(text).toMatch(/QUEUED/)
    console.log(`[${adapter}] steer: ${steered.delivery}/${steered.outcome}`)
  }, HOUR / 4)
})

/**
 * The one thing in this layer that is about Domo's own setting rather than
 * about an adapter.
 *
 * OpenCode publishes no permission mode — `build` and `plan` are its only two,
 * and Build defers to a configured `permission` block — so the only way to stop
 * a session asking is the config Domo injects. This is the pair of runs that
 * proves it: the same prompt, the same environment, one setting apart. Without
 * it a test that only exercised bash and in-`cwd` edits would pass whether the
 * feature worked or not, because neither of those asks either way.
 */
describe('the OpenCode permission policy Domo injects', () => {
  const OUTSIDE_CWD = 'Read the file /etc/hosts with your read tool and reply with its first line.'

  afterAll(async () => {
    const { patchSettings } = await import('../../server/lib/settings')
    await patchSettings({ openCodePermission: { host: 'ask', environment: 'ask' } })
  })

  it('asks about a path outside the working directory, and stops when told not to', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { patchSettings } = await import('../../server/lib/settings')

    // `ask` — OpenCode's own behaviour, which `beforeAll` pinned.
    const asking = await start('opencode')
    const askingAnswers = answerPermissions(asking.id)
    await acpManager.prompt(asking.id, [{ type: 'text', text: OUTSIDE_CWD }])
    const asked = await askingAnswers.stop()

    expect(asked.length, 'OpenCode asked nothing for a read outside cwd').toBeGreaterThan(0)
    expect((await eventsOfType(asking.id, 'permission_request')).length).toBeGreaterThan(0)

    // `allow` — the same turn, with the policy Domo writes into
    // OPENCODE_CONFIG_CONTENT. The setting is read when the adapter starts, so
    // this has to be a new session rather than the same one.
    await patchSettings({ openCodePermission: { host: 'ask', environment: 'allow' } })
    const allowed = await start('opencode')
    const allowedAnswers = answerPermissions(allowed.id)
    const result = await acpManager.prompt(allowed.id, [{ type: 'text', text: OUTSIDE_CWD }])
    const askedAgain = await allowedAnswers.stop()

    expect(result.stopReason).toBe('end_turn')
    expect(askedAgain, 'the permission policy did not suppress the prompt').toEqual([])
    expect(await eventsOfType(allowed.id, 'permission_request')).toEqual([])
    // And it still did the work — a suppressed prompt that also suppressed the
    // read would look identical on the assertions above.
    expect((await eventsOfType(allowed.id, 'tool_call')).length).toBeGreaterThan(0)
  }, HOUR / 2)
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

/**
 * Claude Code wakes itself when a background command it launched finishes, with
 * no `session/prompt` outstanding. This is the only proof that the real adapter
 * says that turn in a shape the runtime catches, and that the turn ends.
 */
describe('a turn Claude Code starts for itself', () => {
  it('opens when its background command finishes, ends, and drains the inbox behind it', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { listInboxMessages } = await import('../../server/lib/repo')
    const session = await start('claude-code', { host: true })
    const answered = answerPermissions(session.id)

    const launched = await acpManager.prompt(session.id, [{
      type: 'text',
      text: 'Use your Bash tool with run_in_background set to true to run exactly: sleep 20 && echo background-done\n'
        + 'Do not wait for it and do not check on it. Reply with the single word LAUNCHED and end your turn. '
        + 'When you are told it has finished, reply with the single word WOKE.'
    }])
    expect(launched.stopReason).toBe('end_turn')

    const adapterTurn = async (type: string) =>
      (await eventsOfType(session.id, type)).filter(event => event.payload?.origin === 'adapter')

    // Nobody prompts it again: the command finishing is what wakes it.
    await vi.waitFor(async () => expect(await adapterTurn('turn_start')).toHaveLength(1), { timeout: 3 * 60_000, interval: 500 })
    const queued = await acpManager.deliver(session.id, {
      content: [{ type: 'text', text: 'Reply with the single word QUEUED.' }],
      delivery: 'queue',
      origin: 'user'
    })
    expect(queued.outcome).toBe('queued')

    await vi.waitFor(async () => expect(await adapterTurn('turn_end')).toHaveLength(1), { timeout: 5 * 60_000, interval: 1000 })
    await vi.waitFor(async () => {
      expect(await listInboxMessages(session.id)).toEqual([])
      expect((await eventsOfType(session.id, 'turn_end')).length).toBe(3)
    }, { timeout: 3 * 60_000, interval: 1000 })
    await answered.stop()

    // Prompted turn, the turn it started itself, then the message that waited.
    const order = (await events(session.id))
      .filter(event => ['user_message', 'turn_start', 'turn_end'].includes(event.type))
      .map(event => event.payload?.origin === 'adapter' ? `${event.type}:adapter` : event.type)
    expect(order).toEqual(['user_message', 'turn_end', 'turn_start:adapter', 'turn_end:adapter', 'user_message', 'turn_end'])
    expect(await assistantText(session.id)).toContain('WOKE')
    console.log(`[claude-code] self-started turn: ${order.join(' → ')}`)
  }, HOUR / 4)
})

describe('an upgrade under live sessions', () => {
  // The upgrade replaces the container the adapters ran in; every session
  // resumes on the new one through `session/load`, reading its state from the
  // home volume (Claude Code, OpenCode, Copilot) or the host's `~/.codex` (Codex).
  it('replaces the container, and every adapter\'s session remembers what it was told before', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { beginProjectEnvironmentUpgrade } = await import('../../server/lib/projects')
    const { getDevEnvironment, listAgentEvents } = await import('../../server/lib/repo')
    const { pinnedAdapterVersions } = await import('../../server/lib/dev-env/runtime-volume')
    const adapters: AgentAdapter[] = ['claude-code', 'codex', 'opencode', 'copilot', 'grok']
    const planted = new Map<string, string>()
    for (const adapter of adapters) {
      const session = await start(adapter)
      const codeword = `quince-${Math.random().toString(36).slice(2, 7)}`
      await acpManager.prompt(session.id, [{ type: 'text', text: `The codeword is ${codeword}. Reply with OK only.` }])
      planted.set(session.id, codeword)
    }
    const before = environment.containerId

    const { upgraded } = await beginProjectEnvironmentUpgrade(environment.id)
    const report = await upgraded
    environment = (await getDevEnvironment(environment.id))!

    expect(environment.containerId).not.toBe(before)
    expect(environment).toMatchObject({ status: 'running', adapterVersions: pinnedAdapterVersions() })
    expect(report.home).toBe('kept')
    for (const [id, codeword] of planted) {
      expect(acpManager.isRunning(id)).toBe(false)
      expect(await listAgentEvents(id)).toContainEqual(expect.objectContaining({ type: 'environment_upgraded' }))
      const answered = answerPermissions(id)
      const result = await acpManager.prompt(id, [{ type: 'text', text: 'What was the codeword I gave you? It starts with quince-. Reply with the whole codeword only.' }])
      await answered.stop()
      expect(result.stopReason).toBe('end_turn')
      expect(await assistantText(id), id).toContain(codeword)
    }
  }, HOUR / 2)
})

describe('cleanup', () => {
  it('leaves no container, worktree or image behind', async () => {
    const { retireEnvironment } = await import('../../server/lib/dev-environments')
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { hostWorktreeExists } = await import('../../server/lib/dev-env/host-worktree')
    const { environmentImageName } = await import('../../server/lib/dev-env/image')

    for (const id of sessions.splice(0)) {
      await acpManager.cancel(id).catch(() => {})
      acpManager.stop(id)
    }
    const id = environment.id
    await retireEnvironment(id)
    environment = null as any

    expect(await docker('ps', '--all', '--quiet', '--filter', `label=domo.envId=${id}`)).toBe('')
    expect(await hostWorktreeExists(repoPath, id)).toBe(false)
    expect(await docker('images', '--quiet', environmentImageName(id))).toBe('')
    // The shared runtime volume is deliberately kept: it is the expensive part.
  }, HOUR / 4)
})
