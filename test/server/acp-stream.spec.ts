import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { query } from '../../server/lib/db'
import { createAgentSession, getAgentSession, listAgentEvents } from '../../server/lib/repo'
import { captureBus } from '../helpers/bus'
import { databaseUnavailable, skipMessage } from '../helpers/database'
import type { AgentEvent } from '~~/shared/types'

/**
 * `onUpdate` is where the cost used to be: one row and one session UPDATE per
 * ACP delta. Driving it from a fake agent — the SDK's own agent side, over a
 * pair of pipes — is the only way to see what a real turn actually writes.
 *
 * Nothing is spawned and nothing is mocked below the ACP boundary: the events
 * here come out of the same Postgres the app uses.
 */
const skip = !!databaseUnavailable()
if (skip) console.warn(`[test] ${skipMessage()}`)

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

/** Serve one turn, scripted by the test, then answer `session/prompt`. */
function serve(adapter: FakeAdapter, turn: Turn) {
  return acp
    .agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false }
    }))
    .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'acp_fake' }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx: any) => {
      await turn(update =>
        ctx.client.notify(acp.methods.client.session.update, { sessionId: ctx.params.sessionId, update })
      )
      return { stopReason: 'end_turn' }
    })
    .onNotification(acp.methods.agent.session.cancel, () => {})
    .connect(adapter.stream())
}

const textChunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

let seen: ReturnType<typeof captureBus>

async function session() {
  return createAgentSession({
    adapter: 'claude-code',
    title: 'Streaming turn',
    cwd: join(tmpdir(), 'domo-test', 'acp-stream')
  })
}

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
  if (skip) return
  await query('truncate agent_sessions cascade')
  state.adapters.length = 0
  seen = captureBus()
})

afterEach(async () => {
  const { acpManager } = await import('../../server/lib/acp/manager')
  await acpManager.shutdown()
  // Let the exit handler's writes land before the next truncate.
  await sleep(50)
  seen.stop()
  vi.restoreAllMocks()
})

describe.skipIf(skip)('a streamed turn', () => {
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
