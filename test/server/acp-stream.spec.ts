import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
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
  listUsageLimits,
  updateAgentSession,
  writeUsageLimits
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
  /** The reasoning-effort select this adapter offers, if any. */
  effort?: { current: string, ids: string[] }
  /** OpenCode's config-option representation of its visible-agent mode. */
  configMode?: { current: string, ids: string[] }
  /** Every `session/set_config_option` the adapter is asked for. */
  onSetConfigOption?: (params: any) => void
  /** The mode state `session/new` and `session/load` report, if any. */
  modes?: { current: string, ids: string[] } | null
  /**
   * The transcript this adapter reads back to the client while it is answering
   * `session/load`, the way both real ones do: claude-agent-acp's
   * `replaySessionHistory` and codex-acp's `streamThreadHistory` each run to
   * completion inside the load request, before its response goes out.
   */
  replay?: any[]
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

/**
 * The reasoning-effort select, shaped the way claude-agent-acp's
 * `buildEffortConfigOption` builds one: its own id, and ACP's `thought_level`
 * category. codex-acp publishes the same category under `reasoning_effort`,
 * which is exactly why nothing in Domo matches on the id.
 */
function effortOption(effort: { current: string, ids: string[] }) {
  return {
    id: 'effort',
    name: 'Effort',
    description: 'Available effort levels for this model',
    category: 'thought_level',
    type: 'select' as const,
    currentValue: effort.current,
    options: effort.ids.map(id => ({ value: id, name: id.toUpperCase() }))
  }
}

function configModeOption(mode: { current: string, ids: string[] }) {
  return {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select' as const,
    currentValue: mode.current,
    options: mode.ids.map(id => ({ value: id, name: id.toUpperCase() }))
  }
}

/** Serve one turn, scripted by the test, then answer `session/prompt`. */
function serve(adapter: FakeAdapter, turn: Turn, options: ServeOptions = {}) {
  // What makes the steering answer meaningful: the real adapters inject into a
  // turn that is running and hand the content back when none is.
  let running = 0
  let cancelled = false
  // What this adapter is on right now, so a set is reflected in the next answer.
  const current = { model: options.models?.current, effort: options.effort?.current, mode: options.configMode?.current }
  const configOptions = () => [
    ...(options.models ? [modelOption({ ...options.models, current: current.model! })] : []),
    ...(options.effort ? [effortOption({ ...options.effort, current: current.effort! })] : []),
    ...(options.configMode ? [configModeOption({ ...options.configMode, current: current.mode! })] : [])
  ]

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
        ...(configOptions().length ? { configOptions: configOptions() } : {}),
        ...(options.modes ? { modes: modeState(options.modes) } : {})
      }
    })
    .onRequest(acp.methods.agent.session.load, async (ctx: any) => {
      // The history, before the response — which is the whole shape of the
      // problem: these are ordinary `session/update` notifications and nothing
      // on the wire says they are not live.
      for (const update of options.replay ?? []) {
        await ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update })
      }
      return {
        // `session/load` restores the adapter's *own* defaults, which is the
        // whole reason Domo re-applies its choices on every attach: the effort
        // comes back at whatever this adapter starts on, not what was picked.
        ...(configOptions().length ? { configOptions: configOptions() } : {}),
        // `null` is the real shape of "loaded, and saying nothing about modes":
        // the SDK lets `session/load` answer with nothing at all.
        ...(options.modes ? { modes: modeState(options.modes) } : {})
      }
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx: any) => {
      options.onSetMode?.(ctx.params)
      return {}
    })
    .onRequest(acp.methods.agent.session.setConfigOption, (ctx: any) => {
      options.onSetConfigOption?.(ctx.params)
      // A real adapter answers with the *whole* set and its current values, so
      // one option's change is also how a client learns the rest still stand.
      if (ctx.params.configId === 'model') current.model = ctx.params.value
      if (ctx.params.configId === 'effort') current.effort = ctx.params.value
      if (ctx.params.configId === 'mode') current.mode = ctx.params.value
      return { configOptions: configOptions() }
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

/**
 * Every session here runs in one directory, and it has to be on disk: a session
 * whose working directory is gone is not startable, so a machine that has never
 * run this file before would fail every turn in it for that reason alone.
 */
const workspace = join(tmpdir(), 'domo-test', 'acp-stream')
mkdirSync(workspace, { recursive: true })

let seen: ReturnType<typeof captureBus>

async function session(title = 'Streaming turn') {
  return createAgentSession({
    adapter: 'claude-code',
    title,
    cwd: workspace
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
  // Account-wide, so it hangs off no session and no cascade reaches it.
  await query('truncate usage_limits')
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
  // The next test is a server that is running again.
  acpManager.open()
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
    // The summary keeps the two messages apart, not "build.Found it."
    expect((await getAgentSession(agent.id))!.summary).toBe('Looking at the build.\n\nFound it.')
  })

  /**
   * The shape OpenCode produces, taken from a real transcript: it announces a
   * tool-call part the instant it exists — `pending`, empty `rawInput` — and
   * that lands between two deltas of a sentence that is still streaming. The
   * row seen there read `Now let me look at` / a tool card / ` the OpenCode
   * normalizer:`, which is one sentence rendered as two bubbles.
   */
  it('keeps one sentence in one row when a tool call is announced mid-text', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'read the normalizer' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(textChunk('Now let me look at'))
      await send({ sessionUpdate: 'tool_call', toolCallId: 'read:2', title: 'Read', kind: 'read', status: 'pending', rawInput: {} })
      await send(textChunk(' the OpenCode normalizer:'))
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'read:2', status: 'completed' })
    })
    await started

    const events = await listAgentEvents(agent.id)

    expect(events.map(event => event.type)).toEqual([
      'user_message',
      'agent_message',
      'tool_call',
      'tool_call_update',
      'turn_end'
    ])
    expect(textOf(events)).toEqual(['Now let me look at the OpenCode normalizer:'])
    // The row kept the `seq` it claimed at its first delta, which is below the
    // tool call's — so the whole sentence renders above the card, not after it.
    const message = events.find(event => event.type === 'agent_message')!
    const call = events.find(event => event.type === 'tool_call')!
    expect(message.seq).toBeLessThan(call.seq)
    expect(message.payload.streaming).toBe(false)
    expect((await getAgentSession(agent.id))!.summary).toBe('Now let me look at the OpenCode normalizer:')
  })

  /**
   * The other half of the same rule, and the reason it is safe: a tool that has
   * actually started *can* have produced something the text after it is about,
   * so the first `tool_call_update` still ends the block. A well-behaved
   * adapter sends that update before its next delta, which is why nothing about
   * Claude Code or codex-acp rendering changes.
   */
  it('still splits the message once the tool call has started', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(textChunk('Looking at the build.'))
      await send({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read', status: 'pending' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
      await send(textChunk('Found it.'))
    })
    await started

    const events = await listAgentEvents(agent.id)

    expect(events.map(event => event.type)).toEqual([
      'user_message',
      'agent_message',
      'tool_call',
      'tool_call_update',
      'tool_call_update',
      'agent_message',
      'turn_end'
    ])
    expect(textOf(events)).toEqual(['Looking at the build.', 'Found it.'])
    const call = events.find(event => event.type === 'tool_call')!
    const [, second] = events.filter(event => event.type === 'agent_message')
    expect(second!.seq).toBeGreaterThan(call.seq)
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
      cwd: workspace,
      model
    })
    const asked: any[] = []
    // The *next* adapter, not the first: a test that boots twice would
    // otherwise script the process it has already finished with and wait
    // forever for the one it just started.
    const index = state.adapters.length
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters.length).toBeGreaterThan(index))
    serve(state.adapters[index]!, async () => {}, { models, onSetConfigOption: params => asked.push(params) })
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

  it('falls back to the adapter\'s own default-model setting, and the row wins over it', async () => {
    // The only install-wide source there is now: the environment pins this
    // used to read were a second, invisible way of saying the same thing.
    const { patchSettings } = await import('../../server/lib/settings')
    try {
      await patchSettings({ defaultAgentModels: { 'claude-code': 'haiku', codex: '', opencode: '' } })
      const fromSetting = await boot(null, { current: 'sonnet', ids: ['sonnet', 'haiku', 'opus'] })
      expect(fromSetting.asked).toEqual([{ sessionId: 'acp_fake', configId: 'model', value: 'haiku' }])

      const fromRow = await boot('opus', { current: 'sonnet', ids: ['sonnet', 'haiku', 'opus'] })
      expect(fromRow.asked).toEqual([{ sessionId: 'acp_fake', configId: 'model', value: 'opus' }])
    } finally {
      // The settings table survives the per-test truncate, so this one has to
      // put it back or every later test in the file boots on `haiku`.
      await patchSettings({ defaultAgentModels: { 'claude-code': '', codex: '', opencode: '' } })
    }
  })

  it('is a no-op for an adapter that offers no model selector', async () => {
    const { agent, asked } = await boot('haiku')

    expect(asked).toEqual([])
    await expect(getAgentSession(agent.id).then(row => row!.model)).resolves.toBe('haiku')
  })

  it('starts anyway on a stale default-model setting, and says which one to fix', async () => {
    // A default the account has since lost access to must not brick every new
    // session on that adapter — and unlike the environment pin this replaced,
    // the user can see it and change it. The notice names the source.
    const { patchSettings } = await import('../../server/lib/settings')
    try {
      await patchSettings({ defaultAgentModels: { 'claude-code': 'gemini-3-pro', codex: '', opencode: '' } })
      const { agent } = await boot(null, { current: 'sonnet', ids: ['sonnet', 'haiku'] })

      const row = await getAgentSession(agent.id)
      expect(row!.status).not.toBe('error')
      expect(row!.model).toBe('sonnet')
      const notice = (await listAgentEvents(agent.id)).find(event => event.type === 'error')
      expect(notice?.payload.message).toMatch(/default model for claude-code.*"gemini-3-pro".*sonnet, haiku/s)
    } finally {
      await patchSettings({ defaultAgentModels: { 'claude-code': '', codex: '', opencode: '' } })
    }
  })

  it('corrects a row the adapter will not honour, rather than leaving it saying so forever', async () => {
    // A model can be recorded with no adapter to check it against, so a typo
    // through the mesh or the API must not leave a session that can
    // never start again — and the row must not go on claiming a model the
    // session is not running.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Model',
      cwd: workspace,
      model: 'gemini-3-pro'
    })
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, { models: { current: 'sonnet', ids: ['sonnet', 'haiku'] } })
    await started

    const row = await getAgentSession(agent.id)
    expect(row!.status).not.toBe('error')
    expect(row!.model).toBe('sonnet')
    // Said where the user is reading, not only in the server log.
    const notice = (await listAgentEvents(agent.id)).find(event => event.type === 'error')
    expect(notice?.payload.message).toMatch(/This session asked for "gemini-3-pro".*sonnet, haiku.*running on sonnet/s)
  })

  it('asks for nothing when a live session is already on the model, or the row alone is behind', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { agent, asked } = await boot('sonnet', { current: 'sonnet', ids: ['sonnet', 'haiku'] })
    expect(asked).toEqual([])

    await acpManager.setModel(agent.id, 'sonnet')
    expect(asked).toEqual([])

    // The row drifting on its own is still the adapter's word that counts.
    await updateAgentSession(agent.id, { model: 'haiku' })
    await acpManager.setModel(agent.id, 'haiku')
    expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'model', value: 'haiku' }])
  })
})

/**
 * The settings that are the *adapter's* own, which Domo does not know the names
 * of.
 *
 * Reasoning effort is the case that forced this: Claude Code publishes it as
 * `effort` and codex-acp as `reasoning_effort`, both under ACP's
 * `thought_level` category, and both only on models that have effort levels at
 * all. So the row records what was asked for by id, the adapter's own answer is
 * what gets rendered, and neither the server nor the UI names either one.
 */
describe('the adapter settings a session runs with', () => {
  const EFFORT = { current: 'medium', ids: ['low', 'medium', 'high'] }

  async function boot(
    config: Record<string, string> | null,
    options: { effort?: { current: string, ids: string[] } } = {}
  ) {
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Effort',
      cwd: workspace
    })
    if (config) await updateAgentSession(agent.id, { config })
    return { agent, ...await attach(agent.id, options.effort ?? EFFORT) }
  }

  /**
   * Serve the adapter this prompt spawns — the *next* one, not the first: a
   * test that boots twice would otherwise script the process it already
   * finished with and wait forever for the one it just started.
   */
  async function attach(agentId: string, effort?: { current: string, ids: string[] }) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const index = state.adapters.length
    const asked: any[] = []
    const started = acpManager.prompt(agentId, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters.length).toBeGreaterThan(index))
    serve(state.adapters[index]!, async () => {}, {
      ...(effort ? { effort } : {}),
      onSetConfigOption: params => asked.push(params)
    })
    await started
    return { asked }
  }

  it('records what the adapter offers, so the picker needs no probe', async () => {
    const { agent } = await boot(null)

    const row = await getAgentSession(agent.id)
    expect(row!.configOptions).toEqual([{
      id: 'effort',
      name: 'Effort',
      description: 'Available effort levels for this model',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'LOW', description: null },
        { value: 'medium', name: 'MEDIUM', description: null },
        { value: 'high', name: 'HIGH', description: null }
      ]
    }])
  })

  it('asks the adapter for what the row asked for, and asks for nothing it is already on', async () => {
    const { asked } = await boot({ effort: 'high' })
    expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'effort', value: 'high' }])

    const already = await boot({ effort: 'medium' })
    expect(already.asked).toEqual([])
  })

  it('re-applies the row on a reattach, because session/load restores the adapter’s own default', async () => {
    // The reason this column exists at all: under `pnpm dev` every edit to
    // `server/` reattaches every session, and the fake comes back on `medium`
    // exactly as a real adapter does.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { agent } = await boot({ effort: 'high' })
    await updateAgentSession(agent.id, { acpSessionId: 'acp_fake' })
    acpManager.stop(agent.id)

    const { asked } = await attach(agent.id, EFFORT)

    expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'effort', value: 'high' }])
  })

  it('skips a setting the adapter does not offer rather than failing the start', async () => {
    // An effort saved against one model must not break a session the user has
    // since moved to a model that has no effort levels.
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Effort',
      cwd: workspace
    })
    await updateAgentSession(agent.id, { config: { effort: 'high' } })
    // No effort option at all, the way Claude Code answers on a model without
    // effort levels.
    await attach(agent.id)

    const row = await getAgentSession(agent.id)
    expect(row!.status).not.toBe('error')
    // Still remembered, for a model that does offer it again later.
    expect(row!.config).toEqual({ effort: 'high' })
  })

  it('changes a setting on a running session and writes back what took', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { agent } = await boot(null)

    await acpManager.setConfigOption(agent.id, 'effort', 'high')

    const row = await getAgentSession(agent.id)
    expect(row!.config).toEqual({ effort: 'high' })
    expect(row!.configOptions?.[0]?.currentValue).toBe('high')
    expect((await listAgentEvents(agent.id)).find(event => event.type === 'config_changed')?.payload)
      .toMatchObject({ configId: 'effort', value: 'high' })
  })

  it('takes the name a person would use, on an adapter that calls it something else', async () => {
    // "reasoning effort" is Codex's name for Claude Code's `effort`, and a
    // caller should not have to know which adapter it is talking to.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { agent } = await boot(null)

    await acpManager.setConfigOption(agent.id, 'reasoning effort', 'High')

    await expect(getAgentSession(agent.id).then(row => row!.config)).resolves.toEqual({ effort: 'high' })
  })

  it('refuses a value the option does not offer, naming the ones it does', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { agent } = await boot(null)

    await expect(acpManager.setConfigOption(agent.id, 'effort', 'maximum'))
      .rejects.toThrow(/does not offer a value matching "maximum".*low, medium, high/s)
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
      cwd: workspace,
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
      cwd: workspace,
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

  it('follows a model and options the adapter changed by itself, without a transcript line', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'opencode',
      title: 'Catalogue',
      cwd: workspace,
      model: 'm1'
    })
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(textChunk('Half a sentence, '))
      // OpenCode 2.0.29, refreshing its catalogue mid-session: a new model list,
      // a different current model, the effort it offers on that one.
      await send({
        sessionUpdate: 'config_option_update',
        configOptions: [
          modelOption({ current: 'm3', ids: ['m1', 'm3'] }),
          effortOption({ current: 'low', ids: ['low', 'high'] }),
          configModeOption({ current: 'plan', ids: ['build', 'plan'] })
        ]
      })
      await send(textChunk('and the rest of it.'))
    }, {
      models: { current: 'm1', ids: ['m1', 'm2'] },
      configMode: { current: 'build', ids: ['build', 'plan'] }
    })
    await started

    const row = (await getAgentSession(agent.id))!
    expect(row).toMatchObject({ model: 'm3', modeId: 'plan' })
    expect(row.configOptions?.map(option => [option.id, option.currentValue])).toEqual([['effort', 'low']])
    const events = await listAgentEvents(agent.id)
    expect(events.map(event => event.type)).not.toContain('config_option_update')
    // State, not transcript: the sentence around it stays one message.
    expect(textOf(events)).toEqual(['Half a sentence, and the rest of it.'])
  })

  it('still writes a line for a mode the user chose, which is what the event is for', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: workspace
    })
    const asked: any[] = []
    // A running session, because that is the case this is about: the mode is
    // asked for now rather than recorded for the next start.
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      modes: { current: 'default', ids: MODES },
      onSetMode: params => asked.push(params)
    })
    await started
    await acpManager.setMode(agent.id, 'plan')

    // Starting a session is not a mode change; somebody choosing one is.
    expect(asked).toEqual([{ sessionId: 'acp_fake', modeId: 'plan' }])
    expect((await listAgentEvents(agent.id)).filter(event => event.type === 'mode_changed'))
      .toEqual([expect.objectContaining({ payload: { modeId: 'plan', name: 'plan' } })])
    await expect(getAgentSession(agent.id).then(row => row!.modeId)).resolves.toBe('plan')
  })

  it('asks for nothing when the adapter is already in the mode, and says nothing either', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: workspace,
      modeId: 'plan'
    })
    const asked: any[] = []
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      modes: { current: 'plan', ids: MODES },
      onSetMode: params => asked.push(params)
    })
    await started

    await acpManager.setMode(agent.id, 'plan')

    expect(asked).toEqual([])
    expect((await listAgentEvents(agent.id)).filter(event => event.type === 'mode_changed')).toEqual([])
  })

  it('asks anyway when the row agrees but the adapter does not', async () => {
    // The whole reason the check is against what the adapter *reports*: a row
    // that has drifted from the process agrees with itself, and a session that
    // came back in the wrong mode would never be put right.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: workspace,
      modeId: 'default'
    })
    const asked: any[] = []
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      modes: { current: 'default', ids: MODES },
      onSetMode: params => asked.push(params)
    })
    await started
    // The row alone moves on: what a `current_mode_update` lost, or a write
    // made while the adapter was down, would look like.
    await updateAgentSession(agent.id, { modeId: 'plan' })

    await acpManager.setMode(agent.id, 'plan')

    expect(asked).toEqual([{ sessionId: 'acp_fake', modeId: 'plan' }])
  })

  it('records the modes a new session offers, and starts it in the row\'s', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Mode',
      cwd: workspace,
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

  it('changes an OpenCode agent through its mode config option', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await createAgentSession({
      adapter: 'opencode',
      title: 'OpenCode mode',
      cwd: workspace,
      modeId: 'build'
    })
    const asked: any[] = []
    // Running, because a stopped session records the mode and asks nobody; the
    // wire representation is what this one is about.
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      configMode: { current: 'build', ids: ['build', 'plan'] },
      onSetConfigOption: params => asked.push(params)
    })
    await started
    await acpManager.setMode(agent.id, 'plan')

    expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'mode', value: 'plan' }])
    const row = await getAgentSession(agent.id)
    expect(row!.modeId).toBe('plan')
    expect(row!.modes).toEqual([
      { id: 'build', name: 'BUILD', description: null },
      { id: 'plan', name: 'PLAN', description: null }
    ])
  })
})

/**
 * Changing a setting is recording a preference, and a preference costs no
 * process.
 *
 * Every one of these is re-applied from the row on the next attach — that is
 * what `session/load` restoring the *adapter's* defaults forces — so a stopped
 * session told "use opus" comes up on opus the next time somebody prompts it.
 * Before this, each of the three opened with `ensureStarted()`, and the
 * composer's pickers are always visible: choosing a reasoning effort on a
 * stopped session spawned an adapter, which for an environment-backed session
 * means starting work inside a container, purely to write a column.
 */
describe('changing a setting on a session that is not running', () => {
  /** What an attach leaves behind: the lists the adapter reported, on the row. */
  const ROW_MODES = [
    { id: 'default', name: 'default', description: null },
    { id: 'plan', name: 'plan', description: null }
  ]
  const ROW_EFFORT = {
    id: 'effort',
    name: 'Effort',
    description: null,
    category: 'thought_level',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'LOW', description: null },
      { value: 'medium', name: 'MEDIUM', description: null },
      { value: 'high', name: 'HIGH', description: null }
    ]
  }

  /** A session that has run before and is not running now. */
  async function stopped() {
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'Stopped',
      cwd: workspace,
      modeId: 'default'
    })
    await updateAgentSession(agent.id, {
      acpSessionId: 'acp_fake',
      status: 'stopped',
      modes: ROW_MODES,
      configOptions: [ROW_EFFORT]
    })
    return agent
  }

  /**
   * Run something and prove no adapter started.
   *
   * `state.adapters` is the spawn log — the mocked `spawn` pushes to it
   * synchronously — so an empty one is the whole property. The wait is not
   * decoration: a boot started and not awaited would be invisible to an
   * assertion made in the same tick as the call, and that is exactly the shape
   * a weak version of this test would keep passing through.
   */
  async function withoutSpawning<T>(fn: () => Promise<T>): Promise<T> {
    const result = await fn()
    await sleep(50)
    expect(state.adapters).toEqual([])
    return result
  }

  it('records a mode on the row and starts nothing', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await stopped()

    await withoutSpawning(() => acpManager.setMode(agent.id, 'plan'))

    const row = await getAgentSession(agent.id)
    expect(row!.modeId).toBe('plan')
    // A setting change leaves the session as stopped as it found it.
    expect(row!.status).toBe('stopped')
    expect(acpManager.isRunning(agent.id)).toBe(false)
    // Somebody did change it, so the log says so — and says only what it can
    // honestly claim, which is that no adapter has taken it yet.
    expect((await listAgentEvents(agent.id)).filter(event => event.type === 'mode_changed'))
      .toEqual([expect.objectContaining({ payload: { modeId: 'plan', name: 'plan', pending: true } })])
  })

  it('records a model on the row and starts nothing', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await stopped()

    await withoutSpawning(() => acpManager.setModel(agent.id, 'opus'))

    const row = await getAgentSession(agent.id)
    // Verbatim: a model list exists only in a `session/new` answer, and probing
    // for one is the spawn this is here to avoid. The attach resolves it.
    expect(row!.model).toBe('opus')
    expect((await listAgentEvents(agent.id)).find(event => event.type === 'model_changed')?.payload)
      .toEqual({ modelId: 'opus', name: 'opus', requested: 'opus', pending: true })
  })

  it('records an adapter setting against the list the adapter last reported', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await stopped()

    // Loosely, exactly as a live session takes it: "reasoning effort" is
    // Codex's name for Claude Code's `effort`.
    await withoutSpawning(() => acpManager.setConfigOption(agent.id, 'reasoning effort', 'High'))

    const row = await getAgentSession(agent.id)
    expect(row!.config).toEqual({ effort: 'high' })
    // What is *not* written: `config_options` is the adapter's own report, and
    // no adapter has confirmed anything. It still says what it last said.
    expect(row!.configOptions).toEqual([ROW_EFFORT])
    expect((await listAgentEvents(agent.id)).find(event => event.type === 'config_changed')?.payload)
      .toMatchObject({ configId: 'effort', value: 'high', pending: true })
  })

  it('refuses what the row knows is not on offer, without starting anything to ask', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await stopped()

    await withoutSpawning(async () => {
      await expect(acpManager.setMode(agent.id, 'bypassPermissions'))
        .rejects.toThrow(/does not offer the mode "bypassPermissions".*default, plan/s)
      await expect(acpManager.setConfigOption(agent.id, 'effort', 'maximum'))
        .rejects.toThrow(/does not offer a value matching "maximum".*low, medium, high/s)
      await expect(acpManager.setConfigOption(agent.id, 'collaboration mode', 'pair'))
        .rejects.toThrow(/no setting matching "collaboration mode"/)
    })

    const row = await getAgentSession(agent.id)
    expect(row!.modeId).toBe('default')
    expect(row!.config).toBeNull()
  })

  it('writes nothing at all when the row already says it', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await stopped()

    await withoutSpawning(() => acpManager.setMode(agent.id, 'default'))

    expect((await listAgentEvents(agent.id)).filter(event => event.type === 'mode_changed')).toEqual([])
  })

  it('hands the lot to the adapter the next time the session runs', async () => {
    // The point of recording rather than applying: nothing is lost, it is
    // applied a moment later than it was chosen.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await stopped()
    await acpManager.setMode(agent.id, 'plan')
    await acpManager.setModel(agent.id, 'opus')
    await acpManager.setConfigOption(agent.id, 'effort', 'high')

    const modes: any[] = []
    const config: any[] = []
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'hello' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, {
      capabilities: { loadSession: true },
      modes: { current: 'default', ids: ['default', 'plan'] },
      models: { current: 'sonnet', ids: ['sonnet', 'opus'] },
      effort: { current: 'medium', ids: ['low', 'medium', 'high'] },
      onSetMode: params => modes.push(params),
      onSetConfigOption: params => config.push(params)
    })
    await started

    expect(modes).toEqual([{ sessionId: 'acp_fake', modeId: 'plan' }])
    expect(config).toEqual([
      { sessionId: 'acp_fake', configId: 'model', value: 'opus' },
      { sessionId: 'acp_fake', configId: 'effort', value: 'high' }
    ])
    const row = await getAgentSession(agent.id)
    expect(row!.modeId).toBe('plan')
    expect(row!.model).toBe('opus')
    expect(row!.config).toEqual({ effort: 'high' })
  })
})

/**
 * `session/load` restores the *adapter's* transcript, and the way an adapter
 * does that is by replaying its history as ordinary `session/update`
 * notifications. Nothing on the wire distinguishes them from live ones, so
 * Domo used to append the lot and the conversation grew a second copy of
 * itself — several times an hour under `pnpm dev`, where every edit to
 * `server/` reattaches every session.
 */
describe('a reattach that restores the adapter’s transcript', () => {
  /** What claude-agent-acp reads back for the one finished turn below. */
  const HISTORY = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix the build' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking at the build.' } },
    { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'that was it' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Found it.' } }
  ]

  /** One real turn, so there is a transcript for the adapter to read back. */
  async function firstTurn() {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session('Reattached')
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(textChunk('Looking at the build.'))
      await send({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read', status: 'pending' })
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
      await send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'that was it' } })
      await send(textChunk('Found it.'))
    })
    await started
    return { acpManager, agent }
  }

  /**
   * Restart the adapter the way Nitro's reload does — stop it, attach again —
   * and let the new one replay `HISTORY` while it answers `session/load`.
   * Deliberately `start`, not `prompt`: an attach on its own is the path that
   * was writing fiction, and a turn of its own would bury it.
   */
  async function reattach(agentId: string, turn: Turn = async () => {}) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const index = state.adapters.length
    acpManager.stop(agentId)
    const loaded = acpManager.start(agentId)
    await vi.waitFor(() => expect(state.adapters.length).toBeGreaterThan(index))
    serve(state.adapters[index]!, turn, { replay: HISTORY })
    await loaded
  }

  it('writes none of the replayed history to the log', async () => {
    const { agent } = await firstTurn()
    const before = await listAgentEvents(agent.id)

    await reattach(agent.id)

    const after = await listAgentEvents(agent.id)
    // The only thing the restart added is the old process going away.
    expect(after.map(event => event.type)).toEqual([...before.map(event => event.type), 'adapter-exit'])
    expect(textOf(after)).toEqual(['Looking at the build.', 'Found it.'])
  })

  it('stays flat across repeated restarts, which is what makes this urgent', async () => {
    const { agent } = await firstTurn()
    const transcript = (events: AgentEvent[]) =>
      events.filter(event => event.type !== 'adapter-exit')
        .map(event => ({ type: event.type, payload: event.payload }))
    const before = transcript(await listAgentEvents(agent.id))

    for (let restart = 0; restart < 3; restart++) await reattach(agent.id)

    expect(transcript(await listAgentEvents(agent.id))).toEqual(before)
  })

  it('still records what the adapter says in the turn that follows', async () => {
    const { acpManager, agent } = await firstTurn()
    await reattach(agent.id, async (send) => {
      await send(textChunk('On it.'))
      await send({ sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Bash', kind: 'execute', status: 'completed' })
    })
    const before = await listAgentEvents(agent.id)

    await acpManager.prompt(agent.id, [{ type: 'text', text: 'now the tests' }])

    const after = await listAgentEvents(agent.id)
    expect(after.slice(before.length).map(event => event.type))
      .toEqual(['user_message', 'agent_message', 'tool_call', 'turn_end'])
  })

  it('records a queued message that drains the moment the adapter attaches', async () => {
    // The hazard the guard has to clear: an idle attach drains the inbox, so
    // the window in which the adapter is not believed must be shut by then.
    const { agent } = await firstTurn()
    await enqueueInboxMessage({
      agentSessionId: agent.id,
      content: [{ type: 'text', text: 'and ship it' }],
      delivery: 'queue',
      origin: 'agent:ag_peer'
    })
    const before = await listAgentEvents(agent.id)

    await reattach(agent.id, async (send) => { await send(textChunk('Shipped.')) })

    await vi.waitFor(async () => {
      const added = (await listAgentEvents(agent.id))
        .slice(before.length)
        .filter(event => event.type !== 'adapter-exit')
      expect(added.map(event => event.type))
        .toEqual(['user_message', 'agent_message', 'turn_end'])
      expect(added[0]!.payload.content[0].text).toContain('and ship it')
      expect(added[0]!.payload.origin).toBe('agent:ag_peer')
    })
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
/**
 * The composer's delivery picker has to say whether a `steer` will really steer
 * or fall back to interrupting, and the pickers are visible on a stopped
 * session — so asking the adapter is exactly what it must not do. The answer is
 * recorded on the row on every attach, the way `config_options` is.
 */
describe('whether a session can be steered', () => {
  async function boot(options: ServeOptions) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const starting = acpManager.start(agent.id)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, options)
    await starting
    return agent
  }

  it('is null until something has attached', async () => {
    const agent = await session()
    expect((await getAgentSession(agent.id))!.steering).toBeNull()
  })

  it('is recorded from what the adapter advertised', async () => {
    const agent = await boot({})
    expect((await getAgentSession(agent.id))!.steering).toBe(true)
  })

  /**
   * The OpenCode case: no top-level `_meta` in its `initialize` response, so a
   * `steer` falls back to `interrupt`. `false` is a measurement and null is
   * not, which is why the two are kept apart.
   */
  it('is false for an adapter that advertises no steering', async () => {
    const agent = await boot({ steering: false })
    expect((await getAgentSession(agent.id))!.steering).toBe(false)
  })
})

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
    // Who sent it, so the transcript can tell a person from another agent.
    expect(user[1]!.payload.origin).toBe('user')
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
    // The sender survives the queue.
    const user = (await listAgentEvents(agent.id)).filter(event => event.type === 'user_message')
    expect(user[1]!.payload.origin).toBe('voice')
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
    // Two senders: the dividers name each, so the row names neither.
    expect(user[1]!.payload).not.toHaveProperty('origin')
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

  it('hands the adapter an answer given the instant the permission appears', async () => {
    // The row is visible before the event and the status are written. An
    // answer in that gap was recorded and reached nobody, and the agent waited
    // on a permission nobody would ask about again. A loop answering as soon
    // as the row exists — what an agent or a test does — lands in it.
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { listPermissions } = await import('../../server/lib/repo')
    const target = await session('Builder')

    const held = heldTurn()
    void acpManager.prompt(target.id, [{ type: 'text', text: 'fix the build' }]).catch(() => {})
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    const agentSide = serve(state.adapters[0]!, held.turn)
    await held.started

    let answered = false
    const answering = (async () => {
      while (!answered) {
        const [pending] = await listPermissions(target.id)
        if (pending) {
          answered = true
          await acpManager.answerPermission(target.id, pending.id, 'allow', 'user')
        }
      }
    })()
    const outcome = await Promise.race([
      agentSide.client.request(acp.methods.client.session.requestPermission, {
        sessionId: 'acp_fake',
        toolCall: { toolCallId: 'c1', title: 'Run `make`' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      } as any),
      sleep(5_000).then(() => 'the adapter was never answered')
    ])
    answered = true
    await answering
    held.release()

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
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

    // The watcher was not running, and the note is what starts it: left in
    // the inbox, it waited for somebody to open the session, and after a
    // restart every subscriber is in that state.
    await vi.waitFor(() => expect(state.adapters).toHaveLength(2))
    const notes: any[] = []
    serve(state.adapters[1]!, async () => {}, { onPrompt: params => notes.push(params) })
    await vi.waitFor(() => expect(notes).toHaveLength(1))
    expect(promptText(notes[0])).toContain('is waiting for a permission: Run `rm -rf build`')
    expect(await listInboxMessages(watcher.id, false).then(rows => rows[0]!.origin)).toBe('system')
    held.release()
  })

  it('tells nobody about a shutdown, starts nothing, and leaves an idle session idle', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const { startSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
    const watcher = await session('Supervisor')
    const idle = await session('Idle')
    const busy = await session('Busy')
    await addAgentSubscription(watcher.id, idle.id, null)
    await addAgentSubscription(watcher.id, busy.id, null)
    await startSubscriptionNotifier()

    const starting = acpManager.start(idle.id)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {})
    await starting
    const held = heldTurn()
    void acpManager.prompt(busy.id, [{ type: 'text', text: 'work' }]).catch(() => {})
    await vi.waitFor(() => expect(state.adapters).toHaveLength(2))
    serve(state.adapters[1]!, held.turn)
    await held.started

    await acpManager.shutdown()
    await sleep(100)

    // Nothing it was doing was cut off, and a message starts it again:
    // "stopped" read as "did not come back" after every update.
    expect((await getAgentSession(idle.id))!.status).toBe('idle')
    expect((await getAgentSession(busy.id))!.status).toBe('stopped')
    // Every adapter exits on a shutdown, and none of it is news to a subscriber.
    await expect(listInboxMessages(watcher.id, false)).resolves.toEqual([])
    expect(state.adapters).toHaveLength(2)
    held.release()
  })
})

/**
 * `message_agent` follows the turn that handles the message, through the mesh
 * endpoint and the real runtime: that turn is decided by the runtime (queued,
 * steered, prompted, drained with others), and only its `user_message` knows.
 */
describe('a message an agent sends', () => {
  async function send(from: string, args: Record<string, unknown>) {
    const { handleMeshMcpRequest } = await import('../../server/lib/mesh/server')
    const { mintMeshToken } = await import('../../server/lib/mesh/token')
    const response = await handleMeshMcpRequest(new Request('http://mesh.internal/api/internal/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'authorization': `Bearer ${mintMeshToken(from)}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: args.tool ?? 'message_agent', arguments: { ...args, tool: undefined } } })
    }))
    const body = await response.json()
    if (body.result.isError) throw new Error(body.result.content[0].text)
    return JSON.parse(body.result.content[0].text)
  }

  /** The notes Domo queued for `agentId`, delivered or not. */
  async function notes(agentId: string): Promise<string[]> {
    return (await listInboxMessages(agentId, false)).filter(row => row.origin === 'system').map(row => row.content[0].text)
  }

  /**
   * A target that holds its first turn until released and answers every later
   * one at once, saying which turn it is.
   */
  async function busyTarget(title = 'Worker') {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const target = await session(title)
    const held = heldTurn()
    let turns = 0
    const prompts: any[] = []
    void acpManager.prompt(target.id, [{ type: 'text', text: 'first job' }]).catch(() => {})
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (say) => {
      turns++
      if (turns === 1) {
        await say(textChunk('Did the first job.'))
        await held.turn(say)
        return
      }
      await say(textChunk(`Answered in turn ${turns}.`))
    }, { onPrompt: params => prompts.push(params) })
    await held.started
    return { target, held, prompts }
  }

  beforeEach(async () => {
    const { startSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
    await startSubscriptionNotifier()
  })

  it('reports on the turn that handles a queued message, not the one it waited behind', async () => {
    const sender = await session('Coordinator')
    const { target, held, prompts } = await busyTarget()

    const sent = await send(sender.id, { agentId: target.id, message: 'the tests fail, fix them' })
    expect(sent).toMatchObject({ outcome: 'queued', notifyWhenDone: 1 })

    held.release()
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    await vi.waitFor(async () => expect(await notes(sender.id)).toHaveLength(1))
    await sleep(100)
    const [note] = await notes(sender.id)
    expect(note).toContain(`Agent Worker (${target.id}) finished its turn (end_turn). Latest output: Answered in turn 2.`)
    expect(note).toContain('That was the last update')
    expect(await notes(sender.id)).toHaveLength(1)
  })

  it('reports on the turn a message is steered into', async () => {
    const sender = await session('Coordinator')
    const { target, held } = await busyTarget()

    const sent = await send(sender.id, { agentId: target.id, message: 'also check lint', delivery: 'steer' })
    expect(sent).toMatchObject({ outcome: 'steered' })
    // Arming is the `user_message` the steer writes, so give it a moment
    // before the turn it joined ends.
    await vi.waitFor(async () => expect((await listAgentEvents(target.id)).filter(event => event.type === 'user_message')).toHaveLength(2))
    await sleep(50)
    held.release()

    await vi.waitFor(async () => expect(await notes(sender.id)).toHaveLength(1))
    expect((await notes(sender.id))[0]).toContain('Latest output: Did the first job.')
  })

  it('reports on a stopped agent the message starts', async () => {
    const sender = await session('Coordinator')
    const target = await session('Worker')

    const sending = send(sender.id, { agentId: target.id, message: 'pick this up' })
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async say => say(textChunk('Picked it up.')))
    expect(await sending).toMatchObject({ outcome: 'prompted', notifyWhenDone: 1 })

    await vi.waitFor(async () => expect(await notes(sender.id)).toHaveLength(1))
    expect((await notes(sender.id))[0]).toContain('Latest output: Picked it up.')
  })

  it('says nothing about a message that was withdrawn', async () => {
    const sender = await session('Coordinator')
    const { target, held, prompts } = await busyTarget()

    const sent = await send(sender.id, { agentId: target.id, message: 'never mind this' })
    await send(sender.id, { tool: 'withdraw_queued_message', agentId: target.id, messageId: sent.messageId })
    held.release()

    await vi.waitFor(async () => expect((await getAgentSession(target.id))!.status).toBe('idle'))
    await sleep(100)
    expect(prompts).toHaveLength(1)
    expect(await notes(sender.id)).toEqual([])
    expect((await query('select * from agent_message_watches')).length).toBe(0)
  })

  it('merges with a subscription the sender already holds rather than telling it twice', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const sender = await session('Coordinator')
    const target = await session('Worker')
    await addAgentSubscription(sender.id, target.id, 1)
    const { startSubscriptionNotifier, stopSubscriptionNotifier } = await import('../../server/lib/acp/subscriptions')
    stopSubscriptionNotifier()
    await startSubscriptionNotifier()
    const starting = acpManager.start(target.id)
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async say => say(textChunk('Done.')))
    await starting

    await send(sender.id, { agentId: target.id, message: 'one more thing', notifyTurns: 2 })

    await vi.waitFor(async () => expect(await notes(sender.id)).toHaveLength(1))
    await sleep(100)
    expect(await notes(sender.id)).toHaveLength(1)
    // The longer of the two windows, counted from the message's turn.
    expect((await notes(sender.id))[0]).toContain('Subscribed for 1 more turn end.')
  })
})

describe('after a restart', () => {
  it('delivers what was left waiting, starting the agent, unless it is old', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const fresh = await session('Fresh')
    const stale = await session('Stale')
    for (const agent of [fresh, stale]) {
      await enqueueInboxMessage({ agentSessionId: agent.id, content: [{ type: 'text', text: 'note' }], delivery: 'queue', origin: 'system' })
    }
    await query(`update agent_inbox set created_at = $1 where agent_session_id = $2`, [new Date(Date.now() - 2 * 3600_000).toISOString(), stale.id])

    const prompts: any[] = []
    await acpManager.resume()
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async () => {}, { onPrompt: params => prompts.push(params) })

    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await expect(listInboxMessages(fresh.id)).resolves.toEqual([])
    await expect(listInboxMessages(stale.id)).resolves.toHaveLength(1)
    expect(state.adapters).toHaveLength(1)
  })
})

/**
 * Context occupancy and cost are session *state*, not transcript.
 *
 * The distinction is the whole design: a `usage_update` arrives with every
 * `message_delta` — several a second on a long answer — and says nothing about
 * what the agent did. Appended like any other update it would close the message
 * being written and take a `seq` in the middle of it, so the text would render
 * split in two around a row nothing draws.
 */
describe('usage updates', () => {
  const usage = (used: number, size = 200_000, extra: Record<string, unknown> = {}) => ({
    sessionUpdate: 'usage_update',
    used,
    size,
    ...extra
  })

  /**
   * Count the writes to the synced column, in Postgres rather than by spying.
   *
   * What the throttle protects is the number of times `agent_sessions` is
   * rewritten — each one re-streams the whole row to every browser, because the
   * table is `REPLICA IDENTITY FULL` — so counting the real UPDATEs is the only
   * measurement that means anything.
   */
  async function countUsageWrites<T>(run: () => Promise<T>): Promise<{ result: T, writes: number }> {
    await query('create table if not exists usage_write_log (at timestamptz default now())')
    await query('truncate usage_write_log')
    await query(`
      create or replace function log_usage_write() returns trigger as $$
      begin
        insert into usage_write_log default values;
        return null;
      end $$ language plpgsql`)
    await query(`
      create or replace trigger usage_write_counter after update on agent_sessions
      for each row when (old.usage is distinct from new.usage) execute function log_usage_write()`)
    try {
      const result = await run()
      const rows = await query<{ count: number }>('select count(*)::int as count from usage_write_log')
      return { result, writes: rows[0]!.count }
    } finally {
      await query('drop trigger if exists usage_write_counter on agent_sessions')
    }
  }

  it('records the reading on the session row', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(usage(12_000))
      await send(usage(48_500, 200_000, { cost: { amount: 0.42, currency: 'USD' } }))
    })
    await started

    await expect(getAgentSession(agent.id)).resolves.toMatchObject({
      usage: {
        context: { used: 48_500, size: 200_000 },
        cost: { amount: 0.42, currency: 'USD' }
      }
    })
  })

  it('writes no agent_events row at all', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      for (const used of [1000, 2000, 3000]) await send(usage(used))
    })
    await started

    const events = await listAgentEvents(agent.id)
    expect(events.map(event => event.type)).toEqual(['user_message', 'turn_end'])
  })

  it('does not split the message it arrives in the middle of', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(textChunk('Look'))
      await send(usage(1000))
      await send(textChunk('ing at '))
      await send(usage(2000))
      await send(textChunk('the build.'))
    })
    await started

    const events = await listAgentEvents(agent.id)
    const messages = events.filter(event => event.type === 'agent_message')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.payload.text).toBe('Looking at the build.')
  })

  it('does not move the streaming row seq, and does not claim one of its own', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    let midTurnSeq: number | null = null

    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(textChunk('Looking'))
      await vi.waitFor(async () => {
        const events = await listAgentEvents(agent.id)
        const message = events.find(event => event.type === 'agent_message')
        expect(message).toBeTruthy()
        midTurnSeq = message!.seq
      })
      for (const used of [1000, 2000, 3000, 4000]) await send(usage(used))
      await send(textChunk(' at it'))
    })
    await started

    const events = await listAgentEvents(agent.id)
    const message = events.find(event => event.type === 'agent_message')!
    // The block kept its place: nothing in between took a `seq`.
    expect(message.seq).toBe(midTurnSeq)
    expect(message.payload.text).toBe('Looking at it')
  })

  it('writes once for a burst, not once per reading', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()

    const { writes } = await countUsageWrites(async () => {
      const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
      await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
      serve(state.adapters[0]!, async (send) => {
        // Forty readings inside one turn, which is an ordinary long answer.
        for (let i = 1; i <= 40; i++) await send(usage(i * 100))
      })
      await started
    })

    // The trailing timer is five seconds and the turn is far shorter, so the
    // flush at the turn boundary is the only write. What is pinned is the
    // bound, not the exact number: forty readings must not be forty UPDATEs.
    expect(writes).toBeGreaterThan(0)
    expect(writes).toBeLessThanOrEqual(2)
    await expect(getAgentSession(agent.id)).resolves.toMatchObject({
      usage: { context: { used: 4000 } }
    })
  })

  it('writes nothing when the reading has not changed', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()

    const { writes } = await countUsageWrites(async () => {
      for (let turn = 0; turn < 2; turn++) {
        const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'again' }])
        if (turn === 0) await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
        serve(state.adapters[0]!, async (send) => {
          await send(usage(7_000))
        })
        await started
      }
    })

    expect(writes).toBe(1)
  })

  it('does not touch last_activity_at, which orders the sessions', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    await updateAgentSession(agent.id, { touch: true })
    const before = (await getAgentSession(agent.id))!.lastActivityAt

    // Straight at the runtime, so no turn boundary touches the row either.
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(usage(5_000))
    })
    await started

    const after = await getAgentSession(agent.id)
    expect(after!.usage).toMatchObject({ context: { used: 5_000 } })
    // The turn itself moved it; what matters is that the row was written with
    // usage and the timestamp did not come from the usage write.
    expect(after!.lastActivityAt).not.toBe(before)
  })

  it('ignores a reading with no usable context window', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(usage(1_000, 0))
    })
    await started

    await expect(getAgentSession(agent.id)).resolves.toMatchObject({ usage: null })
  })
})

/**
 * A `rate_limit_event` rides in on a `usage_update`, and it is the freshest
 * reading of the plan's limits there is: the poller's endpoint answers about
 * once an hour, while this arrives whenever an agent is working.
 */
describe('plan limits that arrive on a working agent', () => {
  const rateLimitUpdate = (info: Record<string, unknown>) => ({
    sessionUpdate: 'usage_update',
    used: 1000,
    size: 200_000,
    _meta: { '_claude/rateLimit': info }
  })

  async function runWith(update: any) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await send(update)
    })
    await started
    return agent
  }

  it('records the windows it names, in percent and ISO', async () => {
    await runWith(rateLimitUpdate({
      status: 'allowed_warning',
      // Fractions, not percentages, and epoch seconds — both straight from the
      // SDK's own schema.
      unifiedWindows: {
        five_hour: { utilization: 0.73, resetsAt: 1_790_000_000 },
        seven_day: { utilization: 0.31, resetsAt: 1_790_600_000 }
      }
    }))

    await vi.waitFor(async () => {
      const limits = await listUsageLimits('claude')
      expect(limits.map(limit => limit.limitId).sort()).toEqual(['five_hour', 'seven_day'])
      expect(limits.find(limit => limit.limitId === 'five_hour')).toMatchObject({
        usedPercent: 73,
        resetsAt: new Date(1_790_000_000_000).toISOString(),
        status: 'allowed_warning',
        source: 'session-event'
      })
    })
  })

  it('never overwrites a fresher polled reading with a sparser one', async () => {
    // The endpoint describes the whole account; this event names one window.
    await writeUsageLimits('claude', [{
      limitId: 'five_hour',
      label: '5-hour limit',
      usedPercent: 52,
      resetsAt: '2026-09-21T17:00:00.000Z',
      windowMinutes: 300,
      status: null,
      amountUsed: null,
      amountLimit: null,
      currency: null,
      source: 'endpoint'
    }], { replace: true })

    await runWith(rateLimitUpdate({
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: 1_790_000_000 } }
    }))

    const limits = await listUsageLimits('claude')
    expect(limits).toEqual([expect.objectContaining({ usedPercent: 52, source: 'endpoint' })])
  })

  it('does take over once the polled reading has gone stale', async () => {
    // Which it will: the endpoint answers roughly hourly, so for most of that
    // hour a working agent is the only current source there is.
    await query(
      `insert into usage_limits
         (provider, limit_id, label, used_percent, window_minutes, source, updated_at)
       values ('claude', 'five_hour', '5-hour limit', 52, 300, 'endpoint', $1)`,
      [new Date(Date.now() - 30 * 60_000).toISOString()]
    )

    await runWith(rateLimitUpdate({
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: 1_790_000_000 } }
    }))

    await vi.waitFor(async () => {
      const limits = await listUsageLimits('claude')
      expect(limits).toEqual([expect.objectContaining({ usedPercent: 99, source: 'session-event' })])
    })
  })

  /**
   * Count the real writes to `usage_limits`, the same way the session-row
   * throttle is measured: in Postgres, because what the debounce protects is
   * the number of times a `REPLICA IDENTITY FULL` row re-streams to every
   * open browser, and a spy on the repo function would not see that.
   */
  async function countLimitWrites<T>(run: () => Promise<T>): Promise<{ result: T, writes: number }> {
    await query('create table if not exists limit_write_log (at timestamptz default now())')
    await query('truncate limit_write_log')
    await query(`
      create or replace function log_limit_write() returns trigger as $$
      begin
        insert into limit_write_log default values;
        return null;
      end $$ language plpgsql`)
    await query(`
      create or replace trigger limit_write_counter after insert or update on usage_limits
      for each row execute function log_limit_write()`)
    try {
      const result = await run()
      const rows = await query<{ count: number }>('select count(*)::int as count from limit_write_log')
      return { result, writes: rows[0]!.count }
    } finally {
      await query('drop trigger if exists limit_write_counter on usage_limits')
    }
  }

  it('writes once for a burst of deltas, not once per reading', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()

    const { writes } = await countLimitWrites(async () => {
      const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
      await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
      serve(state.adapters[0]!, async (send) => {
        // Forty readings inside one turn, which is an ordinary long answer.
        // Every one of them carries the plan limits along with the context
        // reading, and the number barely moves across the whole burst.
        for (let i = 1; i <= 40; i++) {
          await send(rateLimitUpdate({
            status: 'allowed',
            unifiedWindows: { five_hour: { utilization: 0.4 + i / 1000, resetsAt: 1_790_000_000 } }
          }))
        }
      })
      await started
    })

    // The trailing timer is five seconds and the turn is far shorter, so the
    // flush at the turn boundary is the only write. The bound is what is
    // pinned, not the exact number: forty readings must not be forty writes.
    expect(writes).toBeGreaterThan(0)
    expect(writes).toBeLessThanOrEqual(2)
    // And the one that landed is the newest, not the first of the burst.
    await vi.waitFor(async () => {
      expect((await listUsageLimits('claude'))[0]).toMatchObject({ usedPercent: 44 })
    })
  })

  it('writes nothing when the reading has not moved', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const unchanged = () => rateLimitUpdate({
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1_790_000_000 } }
    })

    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'fix the build' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async send => await send(unchanged()))
    await started

    const { writes } = await countLimitWrites(async () => {
      // A second turn reporting exactly what the first one did. The windows
      // move on the scale of minutes, so this is the ordinary case, not an
      // edge one — and the row is account-wide and synced, so rewriting it to
      // say the same thing costs every open browser a round trip.
      const again = acpManager.prompt(agent.id, [{ type: 'text', text: 'and again' }])
      serve(state.adapters[0]!, async send => await send(unchanged()))
      await again
    })

    expect(writes).toBe(0)
  })

  it('leaves the windows it says nothing about alone', async () => {
    await writeUsageLimits('claude', [
      {
        limitId: 'seven_day_opus',
        label: 'Weekly · Opus',
        usedPercent: 8,
        resetsAt: null,
        windowMinutes: 10080,
        status: null,
        amountUsed: null,
        amountLimit: null,
        currency: null,
        source: 'endpoint'
      }
    ], { replace: true })

    await runWith(rateLimitUpdate({
      status: 'allowed',
      unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1_790_000_000 } }
    }))

    await vi.waitFor(async () => {
      const limits = await listUsageLimits('claude')
      expect(limits.map(limit => limit.limitId).sort()).toEqual(['five_hour', 'seven_day_opus'])
    })
  })
})

/**
 * The new-session page creates its session with the first message and moves
 * onto it straight away, so `create` must not wait for the adapter — and the
 * message must survive whatever the boot does, which is why it goes through
 * the inbox rather than straight into a prompt.
 */
describe('a session started by its first message', () => {
  const first = [
    { type: 'resource_link', uri: 'file:///tmp/shot.png', name: 'shot.png', mimeType: 'image/png', size: 3 },
    { type: 'text', text: 'Fix the login page\nIt 500s on submit' }
  ]

  it('returns before the adapter answers, with the message waiting in the inbox', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const created = await acpManager.create({ adapter: 'claude-code', cwd: workspace, firstMessage: first, config: { effort: 'high' } })

    // Nothing has answered `initialize` yet: the fake adapter is unserved.
    expect(created.status).toBe('starting')
    expect(created.title).toBe('Fix the login page')
    expect(created.config).toEqual({ effort: 'high' })
    const waiting = await listInboxMessages(created.id)
    expect(waiting.map(message => message.content)).toEqual([first])
    expect(await listAgentEvents(created.id)).toEqual([])

    const prompts: any[] = []
    const asked: any[] = []
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => { await send(textChunk('On it.')) }, {
      effort: { current: 'medium', ids: ['low', 'medium', 'high'] },
      onPrompt: params => prompts.push(params),
      onSetConfigOption: params => asked.push(params)
    })

    await vi.waitFor(async () => {
      expect((await listAgentEvents(created.id)).map(event => event.type)).toEqual(['user_message', 'agent_message', 'turn_end'])
    })
    // Handed over as written, attachment and all, and only once.
    expect(prompts.map(params => params.prompt)).toEqual([first])
    expect(await listInboxMessages(created.id)).toEqual([])
    // The draft's adapter settings were applied at attach like any other choice.
    expect(asked).toEqual([{ sessionId: 'acp_fake', configId: 'effort', value: 'high' }])
  })

  it('sends a second message after the first, not ahead of it, when it arrives during the boot', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const created = await acpManager.create({ adapter: 'claude-code', cwd: workspace, firstMessage: [{ type: 'text', text: 'first' }] })
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))

    const second = acpManager.deliver(created.id, { content: [{ type: 'text', text: 'second' }], delivery: 'steer', origin: 'user' })
    const prompts: string[] = []
    serve(state.adapters[0]!, async () => {}, { onPrompt: params => prompts.push(promptText(params)) })
    await second

    await vi.waitFor(async () => {
      expect((await listAgentEvents(created.id)).filter(event => event.type === 'turn_end')).toHaveLength(1)
    })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.indexOf('first')).toBeGreaterThanOrEqual(0)
    expect(prompts[0]!.indexOf('first')).toBeLessThan(prompts[0]!.indexOf('second'))
  })

  it('keeps the message in the inbox when the boot fails, for the retry to deliver', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const created = await acpManager.create({ adapter: 'claude-code', cwd: workspace, firstMessage: [{ type: 'text', text: 'still here?' }] })
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    // The adapter dies before it says anything.
    state.adapters[0]!.kill()

    // An adapter that exits reads as stopped, one that fails to start as error; either way it is not starting.
    await vi.waitFor(async () => expect(['stopped', 'error']).toContain((await getAgentSession(created.id))!.status))
    expect((await listInboxMessages(created.id)).map(message => message.content)).toEqual([[{ type: 'text', text: 'still here?' }]])
  })
})

/**
 * A coding agent can begin a turn with nobody prompting it: Claude Code
 * schedules itself to wake up later, is re-invoked when a background task it
 * launched finishes, and can watch for a condition and resume when it changes.
 * The updates arrive exactly as any other turn's do — and no `session/prompt`
 * is outstanding, so nothing will ever answer one to say it ended.
 *
 * Every test below drives that shape directly: the adapter is attached with
 * `start` and never `prompt`, so Domo holds no turn, and the updates go through
 * the same `session/update` notification a prompted turn uses. The watchdog's
 * windows are shortened rather than the clock being faked — `adapterTurnWindows`
 * says why.
 */
describe('a turn the agent starts for itself', () => {
  /** Long enough to be a real deadline, short enough to wait out. */
  const IDLE = 120

  /** Whatever the app ships, so a change to the constant costs nothing here. */
  let windows: { idle: number }

  beforeEach(async () => {
    const { adapterTurnWindows } = await import('../../server/lib/acp/manager')
    windows = { ...adapterTurnWindows }
    adapterTurnWindows.idle = IDLE
  })

  afterEach(async () => {
    const { adapterTurnWindows } = await import('../../server/lib/acp/manager')
    Object.assign(adapterTurnWindows, windows)
  })

  /**
   * Attach an adapter with no turn running and hand back the agent side, so
   * the test can speak unprompted.
   */
  async function attached(title = 'Self-started', options: ServeOptions = {}) {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session(title)
    const index = state.adapters.length
    const started = acpManager.start(agent.id)
    await vi.waitFor(() => expect(state.adapters.length).toBeGreaterThan(index))
    // One `serve` for the whole test: a second one on the same pipes is a
    // second agent connection, and the two then share the adapter's stdin.
    const connection = serve(state.adapters[index]!, async () => {}, options)
    await started
    return { acpManager, agent, connection }
  }

  /** What the agent says when it wakes itself up. */
  const wake = (connection: any, update: any) =>
    connection.client.notify(acp.methods.client.session.update, { sessionId: 'acp_fake', update })

  const typesOf = async (agentId: string) => (await listAgentEvents(agentId)).map(event => event.type)

  const statusOf = async (agentId: string) => (await getAgentSession(agentId))!.status

  it('opens a turn for it, and that turn ends', async () => {
    const { agent, connection } = await attached()

    await wake(connection, textChunk('The build finished. It is green.'))
    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_start'))

    // Before the deadline it is a working session, exactly like a prompted one.
    expect(await statusOf(agent.id)).toBe('thinking')

    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))

    const events = await listAgentEvents(agent.id)
    // No `user_message` anywhere: that is the whole signature of the bug.
    expect(events.map(event => event.type)).toEqual(['turn_start', 'agent_message', 'turn_end'])
    expect(events[0]!.payload).toEqual({ origin: 'adapter' })
    expect(events[2]!.payload.origin).toBe('adapter')
    expect(textOf(events)).toEqual(['The build finished. It is green.'])

    const row = (await getAgentSession(agent.id))!
    expect(row.status).toBe('idle')
    // What the turn said, and only what *this* turn said.
    expect(row.summary).toBe('The build finished. It is green.')
  })

  it('opens no turn for an update that is about the session, not work in it', async () => {
    const { agent, connection } = await attached()

    // Each of these arrives with no turn running in normal use — the title
    // most of all: claude-agent-acp generates it after a turn has ended and
    // publishes it a couple of seconds later.
    await wake(connection, { sessionUpdate: 'session_info_update', title: 'Background task', updatedAt: new Date().toISOString() })
    await wake(connection, { sessionUpdate: 'config_option_update', configOptions: [] })
    await wake(connection, { sessionUpdate: 'available_commands_update', availableCommands: [] })
    await wake(connection, { sessionUpdate: 'current_mode_update', currentModeId: 'default' })
    await wake(connection, { sessionUpdate: 'usage_update', used: 10, size: 1000 })
    // Then real work, so there is something to wait for: notifications are
    // handled in order, so by the time it is seen every update above was too.
    await wake(connection, textChunk('Actually working now.'))
    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_start'))

    const types = await typesOf(agent.id)
    expect(types.filter(type => type === 'turn_start')).toHaveLength(1)
    // The one turn is the text's: nothing ahead of it opened one.
    expect(types.slice(types.indexOf('turn_start'))).toEqual(['turn_start', 'agent_message'])
  })

  it('drains the inbox behind it, which is the part that was silently lost', async () => {
    const prompts: string[] = []
    const { acpManager, agent, connection } = await attached('Self-started', {
      onPrompt: params => prompts.push(promptText(params))
    })

    await wake(connection, textChunk('Waking up to check on that.'))
    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_start'))

    // A peer writes to an agent that looks busy — and it really is busy, so
    // this queues rather than prompting. With no end to the turn it stayed
    // queued for as long as the process lived.
    const delivered = await acpManager.deliver(agent.id, {
      content: [{ type: 'text', text: 'and then deploy it' }],
      delivery: 'queue',
      origin: 'agent:ag_peer'
    })
    expect(delivered.outcome).toBe('queued')
    expect(await listInboxMessages(agent.id)).toHaveLength(1)

    await vi.waitFor(() => expect(prompts).toEqual(['and then deploy it']))
    expect(await listInboxMessages(agent.id)).toHaveLength(0)
    await vi.waitFor(async () => expect(await statusOf(agent.id)).toBe('idle'))
  })

  it('waits for a tool call it opened rather than calling the turn over', async () => {
    const { agent, connection } = await attached()

    await wake(connection, textChunk('Checking the test suite.'))
    await wake(connection, {
      sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', kind: 'execute', status: 'in_progress'
    })
    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('tool_call'))

    // Several times the ordinary window: a suite running in silence is the
    // normal shape of a coding agent's turn, not the end of one.
    await sleep(IDLE * 5)
    expect(await typesOf(agent.id)).not.toContain('turn_end')
    expect(await statusOf(agent.id)).toBe('thinking')

    await wake(connection, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    const completedAt = Date.now()

    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))
    // The quiet window starts again from the tool's last word, not before it.
    expect(Date.now() - completedAt).toBeGreaterThanOrEqual(IDLE)
    expect(await statusOf(agent.id)).toBe('idle')
  })

  it('holds for a tool call that is the first thing the turn says', async () => {
    const { agent, connection } = await attached()

    await wake(connection, {
      sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', kind: 'execute', status: 'in_progress'
    })
    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('tool_call'))

    await sleep(IDLE * 5)
    expect(await typesOf(agent.id)).not.toContain('turn_end')

    await wake(connection, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' })
    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))
  })

  /**
   * An open call has no deadline, so only something that really started a
   * call may open one. claude-agent-acp sends content and `_meta` updates with
   * no status, and `in_progress` beats for calls whose start this turn may
   * never have seen.
   */
  it('lets no update but a tool call hold the turn open', async () => {
    const { agent, connection } = await attached()

    await wake(connection, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read', status: 'pending' })
    await wake(connection, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' })
    await wake(connection, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [] })
    await wake(connection, { sessionUpdate: 'tool_call_update', toolCallId: 'elsewhere', status: 'in_progress' })

    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))
    expect(await statusOf(agent.id)).toBe('idle')
  })

  describe('that Codex reports on', () => {
    const thread = (type: string) => ({
      sessionUpdate: 'session_info_update',
      _meta: { codex: { threadStatus: type === 'active' ? { type, activeFlags: [] } : { type } } }
    })

    it('ends when the thread goes idle, without waiting out the quiet', async () => {
      const { adapterTurnWindows } = await import('../../server/lib/acp/manager')
      adapterTurnWindows.idle = 60_000
      const { agent, connection } = await attached()

      await wake(connection, thread('active'))
      await wake(connection, textChunk('Steered while idle, so this turn is mine.'))
      // A command that outlives the turn: Codex's word that it is idle wins.
      await wake(connection, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'npm run dev', kind: 'execute', status: 'in_progress' })
      await wake(connection, thread('idle'))

      await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))
      expect(await statusOf(agent.id)).toBe('idle')
    })

    it('holds while the thread says it is active, however quiet', async () => {
      const { agent, connection } = await attached()

      await wake(connection, thread('active'))
      await wake(connection, textChunk('Thinking about this for a while.'))
      await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_start'))

      await sleep(IDLE * 5)
      expect(await typesOf(agent.id)).not.toContain('turn_end')
      expect(await statusOf(agent.id)).toBe('thinking')

      await wake(connection, thread('idle'))
      await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))
    })

    it('opens no turn on a status alone', async () => {
      const { agent, connection } = await attached()

      await wake(connection, thread('active'))
      await wake(connection, thread('idle'))
      await sleep(IDLE * 3)
      expect(await typesOf(agent.id)).not.toContain('turn_start')
      expect(await statusOf(agent.id)).toBe('idle')
    })
  })

  describe('held open by a tool call that never reports back', () => {
    async function held(options: ServeOptions = {}) {
      const attachedSession = await attached('Held', options)
      await wake(attachedSession.connection, {
        sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', kind: 'execute', status: 'in_progress'
      })
      await vi.waitFor(async () => expect(await typesOf(attachedSession.agent.id)).toContain('tool_call'))
      return attachedSession
    }

    it('ends on a cancel, and drains the inbox', async () => {
      const prompts: string[] = []
      const { acpManager, agent } = await held({ onPrompt: params => prompts.push(promptText(params)) })
      await enqueueInboxMessage({ agentSessionId: agent.id, content: [{ type: 'text', text: 'after that' }], delivery: 'queue', origin: 'user' })

      await acpManager.cancel(agent.id)

      await vi.waitFor(() => expect(prompts).toEqual(['after that']))
      const events = await listAgentEvents(agent.id)
      const types = events.map(event => event.type)
      // Cancelled, not ended: the `turn_end` that follows is the drained prompt's.
      expect(types.slice(0, types.indexOf('cancelled') + 1)).toEqual(['turn_start', 'tool_call', 'cancelled'])
      expect(events.filter(event => event.type === 'turn_end' && event.payload.origin === 'adapter')).toEqual([])
    })

    it('ends when the adapter exits', async () => {
      const { acpManager, agent } = await held()

      state.adapters.at(-1)!.kill()

      await vi.waitFor(async () => expect(await statusOf(agent.id)).toBe('stopped'))
      expect(acpManager.isBusy(agent.id)).toBe(false)
      expect(await typesOf(agent.id)).not.toContain('turn_end')
    })
  })

  /**
   * The half of this that is easy to get wrong in the other direction.
   *
   * `restoring` drops every update during a `session/load` because an adapter
   * restores a transcript by replaying it, and a replay looks *exactly* like an
   * agent talking with no prompt outstanding — which is now the very thing that
   * opens a turn. Read as news, a reattach would open a turn, write a
   * `turn_start`, and end it twenty seconds later, on every restart.
   */
  describe('after a reattach', () => {
    /** What the adapter reads back while it answers `session/load`. */
    const REPLAY = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix the build' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking at the build.' } },
      { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read', kind: 'read', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'r1', status: 'completed' }
    ]

    /** Stop the adapter and attach again, the way Nitro's reload does. */
    async function reattach(agentId: string) {
      const { acpManager } = await import('../../server/lib/acp/manager')
      const index = state.adapters.length
      acpManager.stop(agentId)
      const loaded = acpManager.start(agentId)
      await vi.waitFor(() => expect(state.adapters.length).toBeGreaterThan(index))
      const connection = serve(state.adapters[index]!, async () => {}, { replay: REPLAY })
      await loaded
      return connection
    }

    it('a replayed transcript starts no turn, however much it looks like one', async () => {
      const { agent } = await attached('Reattached')
      await reattach(agent.id)

      // Long past the window a real one would have ended in.
      await sleep(IDLE * 5)
      const types = await typesOf(agent.id)
      expect(types).not.toContain('turn_start')
      expect(types).not.toContain('turn_end')
      // The replay is not in the log either — that is the fix this must not
      // weaken, asserted here because the two now read the same updates.
      expect(types).toEqual(['adapter-exit'])
      expect(await statusOf(agent.id)).toBe('idle')
    })

    it('a turn the agent starts moments later is still caught', async () => {
      const { agent } = await attached('Reattached')
      const connection = await reattach(agent.id)

      await wake(connection, textChunk('Picking up where I left off.'))
      await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_start'))
      await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))

      // The replay above shares this connection, and none of it is in the log.
      expect(await typesOf(agent.id)).toEqual(['adapter-exit', 'turn_start', 'agent_message', 'turn_end'])
      expect(textOf(await listAgentEvents(agent.id))).toEqual(['Picking up where I left off.'])
      expect(await statusOf(agent.id)).toBe('idle')
    })
  })

  /**
   * Rows written before the watchdog existed are sitting at `thinking` right
   * now, on processes that will not restart just for them. A restart's own
   * sweep in `server/plugins/boot.ts` catches them; this is the lever a person
   * has in the meantime, and it is the retry button they would already press.
   */
  it('recovers a session left stuck by a version that had no watchdog', async () => {
    const { acpManager, agent } = await attached('Stuck')
    const { updateAgentSession } = await import('../../server/lib/repo')

    // The exact shape the bug left: the row says it is working, the adapter is
    // up and idle, and nothing will ever arrive to say otherwise.
    await updateAgentSession(agent.id, { status: 'thinking' })
    expect(await statusOf(agent.id)).toBe('thinking')

    await acpManager.start(agent.id)

    expect(await statusOf(agent.id)).toBe('idle')
    // Nothing invented to explain it: the transcript is the adapter's, not a
    // turn this made up.
    expect(await typesOf(agent.id)).toEqual([])
  })

  it('holds open for a permission, because what that waits on is a person', async () => {
    const { acpManager, agent, connection } = await attached()

    await wake(connection, textChunk('One thing first.'))
    const asked = connection.client.request(acp.methods.client.session.requestPermission, {
      sessionId: 'acp_fake',
      toolCall: { toolCallId: 'c1', title: 'Push to main', kind: 'execute' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('permission_request'))

    // Past enough re-arms of the window to show the gate is not merely a longer
    // deadline: a person may take all afternoon, and the session has to keep
    // saying what it is blocked on the whole time.
    await sleep(IDLE * 8)
    expect(await typesOf(agent.id)).not.toContain('turn_end')
    expect(await statusOf(agent.id)).toBe('awaiting-permission')

    const events = await listAgentEvents(agent.id)
    const permissionId = events.find(event => event.type === 'permission_request')!.payload.permissionId
    await acpManager.answerPermission(agent.id, permissionId, 'allow', 'user')
    await asked

    await vi.waitFor(async () => expect(await typesOf(agent.id)).toContain('turn_end'))
    expect(await statusOf(agent.id)).toBe('idle')
  })
})

/**
 * Claude Code's `Agent` tool with `run_in_background: true`, in the shapes
 * claude-agent-acp 0.81.1 sent on a recorded run: the subagent's calls arrive
 * on the parent's session stamped with the `Agent` call's id, and the
 * `session/prompt` is held open until the subagent is done and Claude Code has
 * answered it — while the cost-bearing `usage_update` marks where the turn
 * itself ended.
 */
describe('a subagent launched in the background', () => {
  const AGENT_CALL = 'toolu_agent'

  const launch = async (send: (update: any) => Promise<void>) => {
    await send({ sessionUpdate: 'tool_call', toolCallId: AGENT_CALL, name: 'Agent', title: 'Task', kind: 'think', status: 'pending', rawInput: {}, _meta: { claudeCode: { toolName: 'Agent', subagent: true } } })
    await send({ sessionUpdate: 'tool_call_update', toolCallId: AGENT_CALL, _meta: { claudeCode: { toolName: 'Agent', toolResponse: { isAsync: true, status: 'async_launched', agentId: 'a1' } } } })
    await send({ sessionUpdate: 'tool_call_update', toolCallId: AGENT_CALL, status: 'completed', _meta: { claudeCode: { toolName: 'Agent' } } })
  }
  const subagentCall = (id: string, command: string) => [
    { sessionUpdate: 'tool_call', toolCallId: id, name: 'Bash', title: command, kind: 'execute', status: 'pending', rawInput: { command }, _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: AGENT_CALL } } },
    { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: 'ok', _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: AGENT_CALL } } }
  ]
  const gate = () => {
    let open!: () => void
    const passed = new Promise<void>((resolve) => { open = resolve })
    return { passed, open }
  }
  const result = (origin: string) => ({ sessionUpdate: 'usage_update', used: 29097, size: 200000, cost: { amount: 0.05, currency: 'USD' }, _meta: { '_claude/origin': { kind: origin } } })

  it('records its calls without cutting the agent\'s message, and nests them under the Agent call', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'start it and tell me about the weather' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      await launch(send)
      await send(textChunk('It is mild '))
      const [call, done] = subagentCall('toolu_bash', 'cd /tmp/acp-research && ls')
      await send(call)
      await send(textChunk('and '))
      await send(done)
      await send(textChunk('dry today.'))
    })
    await started

    const events = await listAgentEvents(agent.id)
    // One message, in one piece, with the subagent's calls logged beside it.
    expect(textOf(events)).toEqual(['It is mild and dry today.'])
    expect((await getAgentSession(agent.id))!.summary).toBe('It is mild and dry today.')
    const nested = events.filter(event => event.payload?._meta?.claudeCode?.parentToolUseId === AGENT_CALL)
    expect(nested.map(event => event.type)).toEqual(['tool_call', 'tool_call_update'])

    const { buildTranscript } = await import('../../app/utils/agentTranscript')
    const items = buildTranscript(events)
    expect(items.map(item => item.kind)).toEqual(['user', 'tool', 'assistant'])
    const card = items[1] as Extract<typeof items[number], { kind: 'tool' }>
    expect(card.tool.children?.map(child => [child.toolCallId, child.status])).toEqual([['toolu_bash', 'completed']])
  })

  it('ends the turn at its result, drains the inbox, and stays idle while the subagent works', async () => {
    const { acpManager } = await import('../../server/lib/acp/manager')
    const agent = await session()
    const subagent = gate()
    const finish = gate()
    const prompts: any[] = []
    const started = acpManager.prompt(agent.id, [{ type: 'text', text: 'start it' }])
    await vi.waitFor(() => expect(state.adapters).toHaveLength(1))
    serve(state.adapters[0]!, async (send) => {
      if (prompts.length > 1) {
        await send(textChunk('PONG'))
        return
      }
      await launch(send)
      await send(textChunk('Launched it.'))
      await send(result('human'))
      // The adapter holds the prompt from here on. The subagent works…
      await subagent.passed
      for (const update of subagentCall('toolu_one', 'sleep 5; echo one')) await send(update)
      // …and when it is done, Claude Code answers it by itself.
      await finish.passed
      await send(textChunk('The subagent finished.'))
      await send(result('task-notification'))
    }, { onPrompt: params => prompts.push(params) })

    // The turn ends at the result, not when the adapter lets go of the prompt.
    await started
    let row = (await getAgentSession(agent.id))!
    expect(row.status).toBe('idle')
    expect(row.summary).toBe('Launched it.')
    expect(acpManager.isBusy(agent.id)).toBe(false)

    // A message for the agent goes straight in rather than waiting on the subagent.
    await acpManager.deliver(agent.id, { content: [{ type: 'text', text: 'ping' }], delivery: 'queue', origin: 'user' })
    await vi.waitFor(() => expect(prompts).toHaveLength(2))
    await vi.waitFor(async () => expect((await getAgentSession(agent.id))!.summary).toBe('PONG'))
    expect((await getAgentSession(agent.id))!.status).toBe('idle')

    // The subagent's calls are recorded, and do not make the session busy.
    subagent.open()
    await vi.waitFor(async () => {
      const events = await listAgentEvents(agent.id)
      expect(events.some(event => event.payload?.toolCallId === 'toolu_one' && event.payload?.status === 'completed')).toBe(true)
    })
    row = (await getAgentSession(agent.id))!
    expect(row.status).toBe('idle')
    // Nor are they the agent starting a turn by itself.
    expect(acpManager.isBusy(agent.id)).toBe(false)
    expect((await listAgentEvents(agent.id)).some(event => event.type === 'turn_start')).toBe(false)

    // Claude Code answering the subagent is a turn it started.
    finish.open()
    await vi.waitFor(async () => {
      const row = (await getAgentSession(agent.id))!
      expect(row.summary).toContain('The subagent finished.')
      expect(row.status).toBe('idle')
    })
    const events = await listAgentEvents(agent.id)
    expect(textOf(events)).toEqual(['Launched it.', 'PONG', 'The subagent finished.'])
    // That one is a turn it started, ended when the adapter let go of the prompt, not after a minute of quiet.
    expect(events.filter(event => event.type === 'turn_start')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', payload: { origin: 'adapter' } })
  })
})
