import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import {
  addAgentSubscription,
  createAgentSession,
  enqueueInboxMessage,
  getAgentSession,
  listAgentEvents,
  listInboxMessages,
  updateAgentSession
} from '../../server/lib/repo'
import { captureBus } from '../helpers/bus'
import type { AgentEvent } from '~~/shared/types'

/**
 * `onUpdate` is where the cost used to be: one row and one session UPDATE per
 * ACP delta. Driving it from a fake agent — the SDK's own agent side, over a
 * pair of pipes — is the only way to see what a real turn actually writes.
 *
 * Nothing is spawned and nothing is mocked below the ACP boundary: the events
 * here come out of the same Postgres the app uses.
 */

const state = vi.hoisted(() => ({ adapters: [] as FakeAdapter[] }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: () => {
      const adapter = new FakeAdapter()
      state.adapters.push(adapter)
      return adapter
    }
  }
})

/** A child process, minus the child. */
class FakeAdapter extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  killed = false

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }

  /** The agent side of the pipes the manager just took the client side of. */
  stream() {
    return acp.ndJsonStream(
      Writable.toWeb(this.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(this.stdin) as ReadableStream<Uint8Array>
    )
  }
}

type Turn = (send: (update: any) => Promise<void>) => Promise<void>

/**
 * The steering extension both real adapters implement. Not a core ACP method
 * and not an `agentCapabilities` entry — it is advertised in the `initialize`
 * response's top-level `_meta`.
 */
const STEERING_METHOD = '_session/steering'

interface ServeOptions {
  /** What the adapter says in `initialize`; the mesh rides on `mcpCapabilities.http`. */
  capabilities?: Record<string, unknown>
  /** Handed the `session/new` params, so a test can look at `mcpServers`. */
  onNewSession?: (params: any) => void
  /** The model select this adapter offers, if any. */
  models?: { current: string, ids: string[] }
  /** Every `session/set_config_option` the adapter is asked for. */
  onSetConfigOption?: (params: any) => void
  /** The mode state `session/new` and `session/load` report, if any. */
  modes?: { current: string, ids: string[] } | null
  /** Every `session/set_mode` the adapter is asked for. */
  onSetMode?: (params: any) => void
  /** Whether `_meta.steering.supported` is advertised. Both real adapters do. */
  steering?: boolean
  /** Every `_session/steering` the adapter is asked for. */
  onSteer?: (params: any) => void
  /** Every `session/prompt` the adapter is asked for. */
  onPrompt?: (params: any) => void
  /** Called when the client sends `session/cancel`. */
  onCancel?: () => void
}

/** A `modes` block shaped the way `SessionModeState` is. */
function modeState(modes: { current: string, ids: string[] }) {
  return {
    currentModeId: modes.current,
    availableModes: modes.ids.map(id => ({ id, name: id }))
  }
}

/** A `configOptions` model selector shaped the way both real adapters send one. */
function modelOption(models: { current: string, ids: string[] }) {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue: models.current,
    options: models.ids.map(id => ({ value: id, name: id.toUpperCase() }))
  }
}

/** Serve one turn, scripted by the test, then answer `session/prompt`. */
function serve(adapter: FakeAdapter, turn: Turn, options: ServeOptions = {}) {
  // What makes the steering answer meaningful: the real adapters inject into a
  // turn that is running and hand the content back when none is.
  let running = 0
  let cancelled = false

  return acp
    .agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, ...options.capabilities },
      ...(options.steering === false ? {} : { _meta: { steering: { supported: true } } })
    }))
    .onRequest(acp.methods.agent.session.new, (ctx: any) => {
      options.onNewSession?.(ctx.params)
      return {
        sessionId: 'acp_fake',
        ...(options.models ? { configOptions: [modelOption(options.models)] } : {}),
        ...(options.modes ? { modes: modeState(options.modes) } : {})
      }
    })
    .onRequest(acp.methods.agent.session.load, () => (
      // `null` is the real shape of "loaded, and saying nothing about modes":
      // the SDK lets `session/load` answer with nothing at all.
      options.modes ? { modes: modeState(options.modes) } : {}
    ))
    .onRequest(acp.methods.agent.session.setMode, (ctx: any) => {
      options.onSetMode?.(ctx.params)
      return {}
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx: any) => {
      options.onSetConfigOption?.(ctx.params)
      // The adapter answers with the full set, reporting what actually took.
      return {
        configOptions: [modelOption({ current: ctx.params.value, ids: options.models?.ids ?? [] })]
      }
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx: any) => {
      options.onPrompt?.(ctx.params)
      running++
      try {
        await turn(update =>
          ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update })
        )
        // A real adapter answers the prompt it was told to cancel, rather than
        // leaving the request hanging for the client's abort to clean up.
        return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
      } finally {
        running--
        cancelled = false
      }
    })
    // Mirrors both real adapters: inject into the turn in flight, and — with
    // the `promptRequired` opt-in — hand an idle steer straight back.
    .onRequest(STEERING_METHOD, (params: any) => params, (ctx: any) => {
      options.onSteer?.(ctx.params)
      if (running > 0) return { outcome: 'injected' }
      return ctx.params?._meta?.steering?.idleBehavior === 'promptRequired'
        ? { outcome: 'promptRequired', reason: 'noRunningTurn' }
        : { outcome: 'startedNewTurn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      cancelled = true
      options.onCancel?.()
    })
    .connect(adapter.stream())
}

const textChunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

let seen: ReturnType<typeof captureBus>

async function session(title = 'Streaming turn') {
  return createAgentSession({
    adapter: 'claude-code',
    title,
    cwd: join(tmpdir(), 'domo-test', 'acp-stream')
  })
}

/**
 * A turn that starts and then hangs until the test lets it finish — which is
 * the only state in which the delivery modes differ from each other.
 */
function heldTurn() {
  let begin!: () => void
  let open!: () => void
  const started = new Promise<void>((resolve) => { begin = resolve })
  const gate = new Promise<void>((resolve) => { open = resolve })
  const turn: Turn = async () => {
    begin()
    await gate
  }
  return { turn, started, release: () => open() }
}

/** The text of a `session/prompt` the fake adapter was handed. */
const promptText = (params: any): string =>
  (params?.prompt ?? []).filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('')

/**
 * Move the clock the runtime throttles on, and nothing else: only `Date.now` is
 * stubbed, so every timestamp written to the database still comes from a real
 * `new Date()` and stays ordered.
 */
function skipAhead(ms: number) {
  const from = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => from + ms)
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function textOf(events: AgentEvent[]): string[] {
  return events.filter(event => event.type === 'agent_message').map(event => event.payload.text)
}

beforeEach(async () => {
  await query('truncate agent_sessions cascade')
  state.adapters.length = 0
  seen = captureBus()
})

afterEach(async () => {
  const { stopSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
  // Before the shutdown below: `adapter-exit` is one of the things a subscriber
  // is told about, and a note delivered into the next test's database is not.
  stopSubscriptionNotifier()
  const { acpManager } = await import('../../server/lib/acp/manager')
  await acpManager.shutdown()
  // Let the exit handler's writes land before the next truncate.
  await sleep(50)
  seen.stop()
  vi.restoreAllMocks()
})

describe('a streamed turn', () => {
  it('writes one row per message block, not one per delta', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    // The adapter only exists once `ensureStarted` has "spawned" it.
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      for (const delta of ['Look', 'ing ', 'at ', 'the ', 'build', '.']) await send(textChunk(delta))
      await send({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read', status: 'pending' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
      for (const delta of ['Found ', 'it', '.']) await send(textChunk(delta))
    })
    await started

    const events = await listAgentEvents(agent.id)

    expect(events.map(event => event.type)).toEqual([
      'user_message',
      'agent_message',
      'tool_call',
      'tool_call_update',
      'agent_message',
      'turn_end'
    ])
    // Nine deltas, two rows — and the tool call still sits between them.
    expect(textOf(events)).toEqual(['Looking at the build.', 'Found it.'])
    expect(events.map(event => event.seq)).toEqual([...events.map(event => event.seq)].sort((a, b) => a - b))
    expect(events.every(event => event.type !== 'agent_message' || event.payload.streaming === false)).toBe(true)
  })

  it('shows a reader who arrives mid-turn the text so far', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    let midTurn: AgentEvent[] = []

    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      for (const delta of ['Look', 'ing ', 'at it']) await send(textChunk(delta))
      // What the browser would be rendering right now, well before the block ends.
      await vi.waitFor(async () => {
        midTurn = await listAgentEvents(agent.id)
        expect(textOf(midTurn)).toEqual(['Looking at it'])
      })
      for (const delta of [', ', 'nearly done']) await send(textChunk(delta))
    })
    await started

    expect(midTurn.find(event => event.type === 'agent_message')!.payload.streaming).toBe(true)
    // The same row, grown in place: the reader's bubble never jumped.
    const events = await listAgentEvents(agent.id)
    expect(events.filter(event => event.type === 'agent_message')).toEqual([
      expect.objectContaining({
        id: midTurn.find(event => event.type === 'agent_message')!.id,
        payload: { text: 'Looking at it, nearly done', streaming: false }
      })
    ])
  })

  it('keeps thoughts and messages in separate rows', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'think first' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'let me ' } })
      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'look' } })
      await send(textChunk('Here goes.'))
    })
    await started

    const events = await listAgentEvents(agent.id)

    expect(events.map(event => event.type)).toEqual([
      'user_message', 'agent_thought', 'agent_message', 'turn_end'
    ])
    expect(events[1]!.payload).toEqual({ text: 'let me look', streaming: false })
  })

  it('writes the session status on a transition, not on every delta', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    seen.clear()
    serve(state.adapters[0]!, async (send) => {
      for (let index = 0; index < 40; index++) await send(textChunk(`${index} `))
    })
    await started

    const changed = seen.events.filter(event => event.type === 'agent-changed')
    expect(changed.length).toBeGreaterThan(0)
    // Forty deltas used to mean forty of these.
    expect(changed.length).toBeLessThan(5)
    await expect(getAgentSession(agent.id)).resolves.toMatchObject({ status: 'idle' })
  })

  it('says the agent is still working through a long block, without writing per delta', async () => {
    // `last_activity_at` is what `list_agent_sessions` reports to the voice
    // agent, and what it picks "the most recently active agent" by. A block that
    // streams for half an hour with no status transition must not look stale.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    let before: string | null = null
    let after: string | null = null
    let writes = 0

    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'this will take a while' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      for (let index = 0; index < 10; index++) await send(textChunk(`${index} `))
      await sleep(250)
      before = (await getAgentSession(agent.id))!.lastActivityAt
      seen.clear()

      // Half a minute into the same block, still nothing but deltas.
      skipAhead(31_000)
      for (let index = 10; index < 20; index++) await send(textChunk(`${index} `))
      await sleep(250)
      after = (await getAgentSession(agent.id))!.lastActivityAt
      writes = seen.events.filter(event => event.type === 'agent-changed').length
    })
    await started
    vi.restoreAllMocks()

    expect(before).toBeTruthy()
    expect(after! > before!).toBe(true)
    // Ten deltas, one write: the refresh is paced by the clock, not by the text.
    expect(writes).toBe(1)
  })

  it('leaves no block streaming when the turn ends', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'say something' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(textChunk('All done'))
    })
    await started

    await expect(getAgentSession(agent.id)).resolves.toMatchObject({ summary: 'All done' })
    const open = await query(
      `select 1 from agent_events where payload->>'streaming' = 'true'`
    )
    expect(open).toEqual([])
  })
})

/**
 * `last_error` is history; `status === 'error'` is the state the user has to act
 * on. A failed turn writes both, a turn starting clears the state, and the
 * transcript keeps the history — which is what lets the UI show the banner only
 * while the session really is broken.
 */
describe('a turn that failed', () => {
  const LIMIT = 'You\'ve hit your session limit · resets 11pm (UTC)'

  /**
   * How a turn fails at the ACP boundary. A bare `throw` inside the adapter
   * reaches the client as JSON-RPC's own bare "Internal error" — the reason
   * ends up in `data` and `lastError` says nothing useful — so a `RequestError`
   * is what a message a person can read has to travel in.
   */
  const refuse = (): never => { throw acp.RequestError.internalError({}, LIMIT) }

  it('records the failure as status and last error, and appends it to the log', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const failed = acpManager
      .prompt(agent.id, [{ type: 'text', text: 'keep going' }])
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => refuse())

    expect(await failed).toBeInstanceOf(Error)

    await expect(getAgentSession(agent.id)).resolves.toMatchObject({
      status: 'error',
      lastError: expect.stringContaining(LIMIT)
    })
    const events = await listAgentEvents(agent.id)
    // No `turn_end`: the turn did not end, it failed.
    expect(events.map(event => event.type)).toEqual(['user_message', 'error'])
    expect(events[1]!.payload.message).toContain(LIMIT)
  })

  it('clears the error when the next turn starts, and leaves it in the transcript', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    let attempt = 0
    const failed = acpManager
      .prompt(agent.id, [{ type: 'text', text: 'keep going' }])
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      attempt++
      if (attempt === 1) refuse()
      await send(textChunk('Back at it.'))
    })
    await failed
    await expect(getAgentSession(agent.id)).resolves.toMatchObject({ status: 'error' })

    // The limit has reset and the user says "continue".
    await acpManager.prompt(agent.id, [{ type: 'text', text: 'continue' }])

    await expect(getAgentSession(agent.id)).resolves.toMatchObject({
      status: 'idle',
      lastError: null
    })
    const events = await listAgentEvents(agent.id)
    expect(events.map(event => event.type)).toEqual([
      'user_message', 'error', 'user_message', 'agent_message', 'turn_end'
    ])
    // Still there, at the moment it happened, which is where it belongs.
    expect(events[1]!.payload.message).toContain(LIMIT)
  })

  it('answers a retry on a live adapter by clearing the state, not by respawning', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const failed = acpManager
      .prompt(agent.id, [{ type: 'text', text: 'keep going' }])
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => refuse())
    await failed

    await acpManager.start(agent.id)

    // The adapter never died, so there is nothing to boot: what the retry fixes
    // is the row, which was describing a turn that is over.
    expect(state.adapters).toHaveLength(1)
    await expect(getAgentSession(agent.id)).resolves.toMatchObject({
      status: 'idle',
      lastError: null
    })
    const events = await listAgentEvents(agent.id)
    expect(events.map(event => event.type)).toEqual(['user_message', 'error'])
  })
})

/**
 * The mesh is an HTTP MCP server Domo hosts itself, so the only thing the
 * adapter is handed is a URL and a bearer token that names the session. An
 * adapter that cannot speak HTTP MCP is given nothing at all, rather than a
 * server it would fail to connect to.
 */
describe('the agent mesh handed to a new session', () => {
  async function newSessionParams(capabilities?: Record<string, unknown>) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    let params: any = null
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      capabilities,
      onNewSession: (received) => {
        params = received
      }
    })
    await started
    return { agent, params }
  }

  it('is an HTTP server whose token verifies back to the session', async () => {
    const { verifyMeshToken } = await import('../../server/lib/mesh/token')
    const { agent, params } = await newSessionParams({ mcpCapabilities: { http: true } })

    const domo = params.mcpServers.find((server: any) => server.name === 'domo')
    expect(domo.type).toBe('http')
    expect(domo.url.endsWith('/api/internal/mcp')).toBe(true)
    const header = domo.headers.find((entry: any) => entry.name === 'Authorization')
    expect(verifyMeshToken(header.value.replace('Bearer ', ''))).toBe(agent.id)
  })

  it('is absent when the adapter does not advertise HTTP MCP', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { params } = await newSessionParams()

    expect(params.mcpServers.find((server: any) => server.name === 'domo')).toBeUndefined()
    warn.mockRestore()
  })
})

describe('the model a session runs on', () => {
  /** Start a session, serve one empty turn, and report what the adapter was asked. */
  async function boot(model: string | null, models?: { current: string, ids: string[] }) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Model',
      cwd: join(tmpdir(), 'domo-test', 'acp-stream'),
      model
    })
    const asked: any[] = []
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, { models, onSetConfigOption: params => asked.push(params) })
    await started
    return { agent, asked }
  }

  it('asks the adapter for the model on the row, and records what it landed on', async () => {
    const { agent, asked } = await boot('haiku', { current: 'sonnet', ids: ['sonnet', 'haiku', 'opus'] })

    expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'model', value: 'haiku' }])
    // The row becomes a record of the truth, not of the request.
    await expect(getAgentSession(agent.id).then(row => row!.model)).resolves.toBe('haiku')
    expect((await listAgentEvents(agent.id)).find(event => event.type === 'model_changed')?.payload)
      .toMatchObject({ modelId: 'haiku', requested: 'haiku' })
  })

  it('resolves a written-out id against the ids the adapter actually offers', async () => {
    // Claude Code lists `haiku`, not `claude-haiku-4-5`; both have to work.
    const { asked } = await boot('claude-haiku-4-5', { current: 'sonnet', ids: ['sonnet', 'haiku'] })

    expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'model', value: 'haiku' }])
  })

  it('asks for nothing when the session is already on the model it wants', async () => {
    const { agent, asked } = await boot('haiku', { current: 'haiku', ids: ['sonnet', 'haiku'] })

    expect(asked).toEqual([])
    await expect(getAgentSession(agent.id).then(row => row!.model)).resolves.toBe('haiku')
  })

  it('pins nothing when the row names no model and no default is set', async () => {
    const { agent, asked } = await boot(null, { current: 'sonnet', ids: ['sonnet', 'haiku'] })

    expect(asked).toEqual([])
    // Still recorded: what it is running on is worth knowing either way.
    await expect(getAgentSession(agent.id).then(row => row!.model)).resolves.toBe('sonnet')
  })

  it('falls back to the install-wide default for a row with no model', async () => {
    process.env.NUXT_CLAUDE_MODEL = 'haiku'
    try {
      const { asked } = await boot(null, { current: 'sonnet', ids: ['sonnet', 'haiku'] })

      expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'model', value: 'haiku' }])
    } finally {
      delete process.env.NUXT_CLAUDE_MODEL
    }
  })

  it('is a no-op for an adapter that offers no model selector', async () => {
    const { agent, asked } = await boot('haiku')

    expect(asked).toEqual([])
    await expect(getAgentSession(agent.id).then(row => row!.model)).resolves.toBe('haiku')
  })

  it('fails the session rather than silently running on the wrong model', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Model',
      cwd: join(tmpdir(), 'domo-test', 'acp-stream'),
      model: 'gemini-3-pro'
    })
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, { models: { current: 'sonnet', ids: ['sonnet', 'haiku'] } })

    await expect(started).rejects.toThrow(/does not offer a model matching "gemini-3-pro"/)
    // The message names what was on offer, so the operator can fix it.
    const row = await getAgentSession(agent.id)
    expect(row!.status).toBe('error')
    expect(row!.lastError).toContain('sonnet, haiku')
  })
})

/**
 * `session/load` restores the *adapter's* transcript, not Domo's choices: it
 * comes back in whatever mode it defaults to. Under `pnpm dev` every edit to
 * `server/` restarts Nitro and reattaches every session, so a mode that is not
 * re-applied lapses within minutes of being chosen — for Claude Code, into
 * asking for permissions again.
 */
describe('the mode a session runs in', () => {
  const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

  /** Start a session the runtime has to reattach to, and report what it asked. */
  async function reattach(input: { modeId: string, reports: string | null }) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: join(tmpdir(), 'domo-test', 'acp-stream'),
      modeId: input.modeId
    })
    // What a session that has run before looks like: an adapter-side id to
    // load, and the mode list its `session/new` reported back then.
    await updateAgentSession(agent.id, {
      acpSessionId: 'acp_fake',
      modes: MODES.map(id => ({ id, name: id, description: null }))
    })
    const asked: any[] = []
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      capabilities: { loadSession: true },
      modes: input.reports ? { current: input.reports, ids: MODES } : null,
      onSetMode: params => asked.push(params)
    })
    await started
    return { agent, asked }
  }

  it('puts a reattached session back in the mode the row asks for', async () => {
    const { agent, asked } = await reattach({ modeId: 'bypassPermissions', reports: 'default' })

    expect(asked).toEqual([{ sessionId: 'acp_fake', modeId: 'bypassPermissions' }])
    await expect(getAgentSession(agent.id).then(row => row!.modeId)).resolves.toBe('bypassPermissions')
  })

  it('asks anyway when the load says nothing about modes, since the row knows there are some', async () => {
    // `session/load` is allowed to answer with nothing at all, and an adapter
    // that says nothing has still gone back to its own default.
    const { agent, asked } = await reattach({ modeId: 'plan', reports: null })

    expect(asked).toEqual([{ sessionId: 'acp_fake', modeId: 'plan' }])
    await expect(getAgentSession(agent.id).then(row => row!.modeId)).resolves.toBe('plan')
  })

  it('asks for nothing, and logs nothing, when the adapter came back in the right mode', async () => {
    const { agent, asked } = await reattach({ modeId: 'plan', reports: 'plan' })

    expect(asked).toEqual([])
    await expect(getAgentSession(agent.id).then(row => row!.modeId)).resolves.toBe('plan')
  })

  it('adds no "mode set to" line to the transcript on a re-apply', async () => {
    // The row already said this; a restart is not a mode change, and one line
    // per restart would bury the turn it is attached to.
    const { agent } = await reattach({ modeId: 'bypassPermissions', reports: 'default' })

    expect((await listAgentEvents(agent.id)).filter(event => event.type === 'mode_changed')).toEqual([])
  })

  it('follows a mode the agent switched by itself', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: join(tmpdir(), 'domo-test', 'acp-stream'),
      modeId: 'default'
    })
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' })
    }, { modes: { current: 'default', ids: MODES } })
    await started

    // The log alone would be lost on the next attach, which re-applies the row.
    await expect(getAgentSession(agent.id).then(row => row!.modeId)).resolves.toBe('acceptEdits')
    expect((await listAgentEvents(agent.id)).map(event => event.type)).toContain('current_mode_update')
  })

  it('still writes a line for a mode the user chose, which is what the event is for', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: join(tmpdir(), 'domo-test', 'acp-stream')
    })
    const asked: any[] = []
    const setting = acpManager.setMode(agent.id, 'plan')
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      modes: { current: 'default', ids: MODES },
      onSetMode: params => asked.push(params)
    })
    await setting

    // Starting a session is not a mode change; somebody choosing one is.
    expect(asked).toEqual([{ sessionId: 'acp_fake', modeId: 'plan' }])
    expect((await listAgentEvents(agent.id)).filter(event => event.type === 'mode_changed'))
      .toEqual([expect.objectContaining({ payload: { modeId: 'plan' } })])
    await expect(getAgentSession(agent.id).then(row => row!.modeId)).resolves.toBe('plan')
  })

  it('records the modes a new session offers, and starts it in the row\'s', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: join(tmpdir(), 'domo-test', 'acp-stream'),
      modeId: 'plan'
    })
    const asked: any[] = []
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      modes: { current: 'default', ids: MODES },
      onSetMode: params => asked.push(params)
    })
    await started

    expect(asked).toEqual([{ sessionId: 'acp_fake', modeId: 'plan' }])
    const row = await getAgentSession(agent.id)
    expect(row!.modeId).toBe('plan')
    // The list is what the picker offers; it comes from the adapter, once.
    expect(row!.modes).toEqual(MODES.map(id => ({ id, name: id, description: null })))
  })
})

/**
 * There is no way to send a message to an agent that does not end here, and the
 * thing that makes it interesting is a turn already running.
 *
 * Both installed adapters accept a second `session/prompt` mid-turn and queue
 * it in a queue of their own — invisible to Domo and gone on restart. So Domo
 * never sends one: a message either joins the running turn through the
 * `_session/steering` extension, becomes an `agent_inbox` row, or cancels the
 * turn first.
 */
describe('delivering a message to an agent that is already working', () => {
  /** Start a turn and hang it, so the session really is mid-turn. */
  async function working(options: ServeOptions = {}) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const prompts: any[] = []
    const steered: any[] = []
    let cancelled = 0
    const held = heldTurn()

    const running = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, held.turn, {
      ...options,
      onPrompt: params => prompts.push(params),
      onSteer: params => steered.push(params),
      onCancel: () => {
        cancelled++
        // A real adapter ends the turn it was told to cancel.
        held.release()
      }
    })
    await held.started

    return { acpManager, agent, prompts, steered, running, release: held.release, cancelled: () => cancelled }
  }

  it('steers into the running turn instead of sending a second prompt', async () => {
    const { acpManager, agent, prompts, steered, running, release } = await working()

    const result = await acpManager.deliver(agent.id, {
      content: [{ type: 'text', text: 'do the tests first' }],
      delivery: 'steer'
    })

    expect(result).toMatchObject({ delivery: 'steer', outcome: 'steered' })
    expect(steered).toHaveLength(1)
    expect(steered[0]!.prompt).toEqual([{ type: 'text', text: 'do the tests first' }])
    // The opt-in that keeps an idle steer from starting a turn Domo cannot see.
    expect(steered[0]!._meta).toEqual({ steering: { idleBehavior: 'promptRequired' } })
    // The one thing that must never happen while a turn is running.
    expect(prompts).toHaveLength(1)

    release()
    await running
    // The agent is about to answer it, so the transcript shows it in its place.
    const user = (await listAgentEvents(agent.id)).filter(event => event.type === 'user_message')
    expect(user.map(event => event.payload.content[0].text)).toEqual(['fix the build', 'do the tests first'])
    expect(user[1]!.payload.delivery).toBe('steer')
  })

  it('queues a message as a row, and delivers it when the turn ends', async () => {
    const { acpManager, agent, prompts, steered, running, release } = await working()

    const result = await acpManager.deliver(agent.id, {
      content: [{ type: 'text', text: 'then push it' }],
      delivery: 'queue',
      origin: 'voice'
    })

    expect(result).toMatchObject({ delivery: 'queue', outcome: 'queued' })
    expect(steered).toEqual([])
    expect(prompts).toHaveLength(1)
    await expect(listInboxMessages(agent.id)).resolves.toMatchObject([
      { delivery: 'queue', origin: 'voice', deliveredAt: null, content: [{ type: 'text', text: 'then push it' }] }
    ])

    release()
    await running

    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    // One row is handed over exactly as it was written: nothing prefixed, no
    // divider, the same content the caller queued.
    expect(promptText(prompts[1])).toBe('then push it')
    expect(prompts[1]!.prompt).toEqual([{ type: 'text', text: 'then push it' }])
    // Nothing waiting, and the row records when it went out.
    await expect(listInboxMessages(agent.id)).resolves.toEqual([])
    await expect(listInboxMessages(agent.id, false)).resolves.toMatchObject([
      { deliveredAt: expect.any(String) }
    ])
  })

  /**
   * Two notes that arrived during one turn are one thing to answer. A turn each
   * meant the second one arrived after the agent had already answered the
   * first, reading that answer as context nobody asked for — and cost two
   * round trips to say so.
   */
  it('drains everything that piled up as one turn, each message named', async () => {
    const { acpManager, agent, prompts, running, release } = await working()

    for (const [text, origin] of [
      ['the deploy finished', 'system'],
      ['take a look when you can', 'agent:ag_peer']
    ] as const) {
      await acpManager.deliver(agent.id, { content: [{ type: 'text', text }], delivery: 'queue', origin })
    }
    await expect(listInboxMessages(agent.id)).resolves.toHaveLength(2)

    release()
    await running

    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    // Two messages, one prompt — and a divider so the agent can tell that it is
    // being handed two of them rather than one run-on sentence.
    expect(promptText(prompts[1])).toBe(
      '[From Domo]\nthe deploy finished\n[Message from agent ag_peer]\ntake a look when you can'
    )
    // Both rows went out in the same claim, in `seq` order.
    await expect(listInboxMessages(agent.id)).resolves.toEqual([])
    await expect(listInboxMessages(agent.id, false)).resolves.toMatchObject([
      { origin: 'system', deliveredAt: expect.any(String) },
      { origin: 'agent:ag_peer', deliveredAt: expect.any(String) }
    ])

    // One turn means one `user_message`, and it carries the whole batch.
    const user = (await listAgentEvents(agent.id)).filter(event => event.type === 'user_message')
    expect(user).toHaveLength(2)
    expect(user[1]!.payload.content).toEqual(prompts[1]!.prompt)
  })

  it('cancels the running turn first when told to interrupt', async () => {
    const { acpManager, agent, prompts, running, cancelled } = await working()

    const result = await acpManager.deliver(agent.id, {
      content: [{ type: 'text', text: 'stop, do this instead' }],
      delivery: 'interrupt'
    })

    expect(result).toMatchObject({ delivery: 'interrupt', outcome: 'prompted' })
    expect(cancelled()).toBe(1)
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    expect(promptText(prompts[1])).toBe('stop, do this instead')

    // A deliberate abort is not a failure: the session must not land in
    // `error`, whether the adapter's `cancelled` answer or the client's own
    // abort gets there first.
    await expect(running).resolves.toEqual({ stopReason: 'cancelled' })
    const types = (await listAgentEvents(agent.id)).map(event => event.type)
    expect(types).toContain('cancelled')
    expect(types).not.toContain('error')
  })

  it('interrupts instead of steering when the adapter cannot steer', async () => {
    // The intent is "change course now"; queueing is the one thing it does not
    // mean, so the fallback is the other mode that acts at once.
    const { acpManager, agent, prompts, steered, cancelled } = await working({ steering: false })

    const result = await acpManager.deliver(agent.id, {
      content: [{ type: 'text', text: 'change of plan' }],
      delivery: 'steer'
    })

    expect(result).toMatchObject({ delivery: 'interrupt', outcome: 'prompted' })
    expect(steered).toEqual([])
    expect(cancelled()).toBe(1)
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    expect(promptText(prompts[1])).toBe('change of plan')
  })
})

describe('delivering a message to an agent that is idle', () => {
  /** Boot a session without giving it a turn. */
  async function idle(options: ServeOptions = {}) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const prompts: any[] = []
    const steered: any[] = []

    const starting = acpManager.start(agent.id)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      ...options,
      onPrompt: params => prompts.push(params),
      onSteer: params => steered.push(params)
    })
    await starting

    return { acpManager, agent, prompts, steered }
  }

  it('prompts rather than steering, whatever the delivery says', async () => {
    const { acpManager, agent, prompts, steered } = await idle()

    const result = await acpManager.deliver(agent.id, {
      content: [{ type: 'text', text: 'start here' }],
      delivery: 'steer'
    })

    expect(result).toMatchObject({ outcome: 'prompted' })
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect(promptText(prompts[0])).toBe('start here')
    // Sending the extension at all would hand the turn to the adapter: its
    // output would stream, but nothing would ever resolve a `session/prompt`.
    expect(steered).toEqual([])
  })

  it('hands over what was waiting when the adapter attaches', async () => {
    // The point of owning the queue: a message queued before a restart is still
    // there afterwards, and the attach is what delivers it.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    await enqueueInboxMessage({
      agentSessionId: agent.id,
      content: [{ type: 'text', text: 'pick this up' }],
      delivery: 'queue',
      origin: 'agent:ag_peer'
    })

    const prompts: any[] = []
    const starting = acpManager.start(agent.id)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, { onPrompt: params => prompts.push(params) })
    await starting

    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect(promptText(prompts[0])).toBe('pick this up')
    await vi.waitFor(async () => expect(await listInboxMessages(agent.id)).toEqual([]))
  })
})

/**
 * An agent cannot wait for a peer: its own turn ends, and the peer's finishes
 * minutes later. A subscription is how it finds out, and the note is an
 * ordinary queued message — so it never cuts across a turn of its own.
 */
describe('subscriptions between agents', () => {
  it('tells a subscriber what the agent it follows just did', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { startSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
    const watcher = await session('Supervisor')
    const target = await session('Builder')
    await addAgentSubscription(watcher.id, target.id)
    await startSubscriptionNotifier()

    // The watcher is up and idle, so the note it is queued becomes its next turn.
    const notes: any[] = []
    const starting = acpManager.start(watcher.id)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, { onPrompt: params => notes.push(params) })
    await starting

    const running = acpManager.prompt(target.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(2))
    serve(state.adapters[1]!, async (send) => {
      await send(textChunk('Fixed the build.'))
    })
    await running

    await vi.waitFor(() => expect(notes).toHaveLength(1))
    expect(promptText(notes[0])).toBe(
      `Agent Builder (${target.id}) finished its turn (end_turn). Latest output: Fixed the build.`
    )
  })

  it('says which permission an agent it follows is stuck on', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { startSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
    const watcher = await session('Supervisor')
    const target = await session('Builder')
    await addAgentSubscription(watcher.id, target.id)
    await startSubscriptionNotifier()

    const held = heldTurn()
    void acpManager.prompt(target.id, [{ type: 'text', text: 'fix the build' }]).catch(() => {})
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    const agentSide = serve(state.adapters[0]!, held.turn)
    await held.started

    void agentSide.client.request(acp.methods.client.session.requestPermission, {
      sessionId: 'acp_fake',
      toolCall: { toolCallId: 'c1', title: 'Run `rm -rf build`' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    } as any).catch(() => {})

    // The watcher was never started, and a note must not be what starts it: an
    // `adapter-exit` is one of these, and `shutdown()` raises one per session.
    await vi.waitFor(async () => {
      const queued = await listInboxMessages(watcher.id)
      expect(queued).toHaveLength(1)
      expect(queued[0]!.content[0].text).toContain('is waiting for a permission: Run `rm -rf build`')
    })
    expect(state.adapters).toHaveLength(1)
    expect(await listInboxMessages(watcher.id).then(rows => rows[0]!.origin)).toBe('system')
    held.release()
  })
})
