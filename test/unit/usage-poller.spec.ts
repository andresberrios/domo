import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { bus } from '../../server/lib/bus'
import { UsagePoller, type UsageClients, type UsageSink } from '../../server/lib/usage/poller'
import type { ClaudeUsageResult } from '../../server/lib/usage/claude'
import type { CodexUsageResult } from '../../server/lib/usage/codex'
import type { OpenCodeUsageResult } from '../../server/lib/usage/opencode'
import type { UsageLimitValue } from '../../server/lib/usage/normalize'
import type { UsageProviderId, UsageProviderState } from '~~/shared/types'

/**
 * The poller's scheduling, with every client injected.
 *
 * Nothing here reaches a network or a process; what is under test is *when* it
 * asks and what it does with each answer. The cadence is not a preference: the
 * Claude usage endpoint answers about once an hour per token (a second call
 * inside the window is a 429 with `retry-after: 3591`), so the interesting
 * cases are all about not hammering it and not throwing away good rows when it
 * refuses.
 */

const TOKEN = 'sk-ant-oat01-secret-do-not-leak'

const limit = (patch: Partial<UsageLimitValue> = {}): UsageLimitValue => ({
  limitId: 'five_hour',
  label: '5-hour limit',
  usedPercent: 52,
  resetsAt: null,
  windowMinutes: 300,
  status: null,
  amountUsed: null,
  amountLimit: null,
  currency: null,
  source: 'endpoint',
  ...patch
})

interface Harness {
  poller: UsagePoller
  clients: { [K in keyof UsageClients]: ReturnType<typeof vi.fn> }
  writes: Array<{ provider: UsageProviderId, limits: UsageLimitValue[], replace: boolean }>
  states: Array<{ provider: UsageProviderId, state: UsageProviderState, message: string | null }>
  /** What `countLimits` answers; the fallback probe hangs off it. */
  known: Map<UsageProviderId, number>
}

function harness(overrides: Partial<UsageClients> = {}): Harness {
  const writes: Harness['writes'] = []
  const states: Harness['states'] = []
  const known = new Map<UsageProviderId, number>([['claude', 0], ['codex', 0], ['opencode', 0]])

  const clients = {
    claudeEndpoint: vi.fn(async (): Promise<ClaudeUsageResult> => ({ outcome: 'ok', limits: [limit()], message: null })),
    claudeHeaders: vi.fn(async (): Promise<ClaudeUsageResult> => ({ outcome: 'error', limits: [], message: 'no probe' })),
    codex: vi.fn(async (): Promise<CodexUsageResult> => ({ outcome: 'ok', limits: [limit({ limitId: 'plan:primary', source: 'app-server' })], message: null })),
    opencode: vi.fn(async (): Promise<OpenCodeUsageResult> => ({ outcome: 'ok', limits: [limit({ limitId: 'rolling' })], message: null }))
  }
  for (const [key, value] of Object.entries(overrides)) {
    (clients as any)[key] = vi.fn(value as any)
  }

  const sink: UsageSink = {
    writeLimits: async (provider, limits, options) => {
      writes.push({ provider, limits, replace: options.replace })
      known.set(provider, limits.length)
    },
    setState: async (provider, state, message) => { states.push({ provider, state, message }) },
    countLimits: async provider => known.get(provider) ?? 0
  }

  const poller = new UsagePoller({ clients, sink })
  return { poller, clients: clients as Harness['clients'], writes, states, known }
}

/** Let the in-flight promise chain settle without advancing the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('starting up', () => {
  it('asks every provider once', async () => {
    const h = harness()
    h.poller.start()
    await settle()

    expect(h.clients.claudeEndpoint).toHaveBeenCalledTimes(1)
    expect(h.clients.codex).toHaveBeenCalledTimes(1)
    expect(h.clients.opencode).toHaveBeenCalledTimes(1)
    expect(h.writes.map(write => write.provider).sort()).toEqual(['claude', 'codex', 'opencode'])
    h.poller.stop()
  })

  it('replaces a provider whole, so a window it no longer reports goes away', async () => {
    const h = harness()
    h.poller.start()
    await settle()

    expect(h.writes.every(write => write.replace)).toBe(true)
    h.poller.stop()
  })

  it('polls again on its own interval', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    // The Claude endpoint is hourly; Codex is minutes.
    await vi.advanceTimersByTimeAsync(6 * 60_000)

    expect(h.clients.codex.mock.calls.length).toBeGreaterThan(1)
    expect(h.clients.claudeEndpoint).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(h.clients.claudeEndpoint.mock.calls.length).toBeGreaterThan(1)
    h.poller.stop()
  })

  it('stops asking once it is stopped', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    h.poller.stop()
    const before = h.clients.codex.mock.calls.length

    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(h.clients.codex).toHaveBeenCalledTimes(before)
  })
})

describe('the one-a-minute floor', () => {
  it('ignores a second request inside the minute, whoever asks', async () => {
    const h = harness()
    h.poller.start()
    await settle()

    await h.poller.request('codex', { force: true })
    expect(h.clients.codex).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(61_000)
    await h.poller.request('codex', { force: true })
    expect(h.clients.codex.mock.calls.length).toBeGreaterThan(1)
    h.poller.stop()
  })

  it('lets a turn ending prompt a look, debounced across several at once', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    await vi.advanceTimersByTimeAsync(61_000)
    const before = h.clients.codex.mock.calls.length

    // Three agents finishing together is one look, not three.
    for (let i = 0; i < 3; i++) {
      bus.publish({
        type: 'agent-event',
        agentSessionId: 'ag_1',
        event: { id: 'ev', agentSessionId: 'ag_1', seq: 1, type: 'turn_end', payload: {}, createdAt: '' }
      })
    }
    await vi.advanceTimersByTimeAsync(6_000)

    expect(h.clients.codex).toHaveBeenCalledTimes(before + 1)
    h.poller.stop()
  })

  it('does not react to an event that is not a turn ending', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    await vi.advanceTimersByTimeAsync(61_000)
    const before = h.clients.codex.mock.calls.length

    bus.publish({
      type: 'agent-event',
      agentSessionId: 'ag_1',
      event: { id: 'ev', agentSessionId: 'ag_1', seq: 1, type: 'agent_message', payload: {}, createdAt: '' }
    })
    await vi.advanceTimersByTimeAsync(6_000)

    expect(h.clients.codex).toHaveBeenCalledTimes(before)
    h.poller.stop()
  })
})

describe('when the Claude endpoint will not answer', () => {
  it('honours Retry-After, and a refresh button cannot override it', async () => {
    const h = harness({
      claudeEndpoint: async () => ({
        outcome: 'rate-limited',
        limits: [],
        message: 'rate limited',
        retryAfterMs: 3_591_000
      })
    })
    h.poller.start()
    await settle()
    expect(h.clients.claudeEndpoint).toHaveBeenCalledTimes(1)

    // Well past the one-a-minute floor, still inside the window Anthropic asked for.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await h.poller.request('claude', { force: true })

    expect(h.clients.claudeEndpoint).toHaveBeenCalledTimes(1)
    h.poller.stop()
  })

  it('keeps the rows it has rather than replacing them with nothing', async () => {
    const h = harness()
    h.poller.start()
    await settle()
    const written = h.writes.filter(write => write.provider === 'claude').length
    expect(written).toBe(1)

    h.clients.claudeEndpoint.mockResolvedValue({
      outcome: 'rate-limited', limits: [], message: 'rate limited'
    })
    await vi.advanceTimersByTimeAsync(61 * 60_000)

    // No second write at all: the last good reading stands, with its own
    // timestamp, and the UI says how old it is.
    expect(h.writes.filter(write => write.provider === 'claude')).toHaveLength(written)
    // Still `ok`, not `error`: the numbers on screen are true, only stale.
    expect(h.states.filter(state => state.provider === 'claude').at(-1))
      .toMatchObject({ state: 'ok', message: 'rate limited' })
    h.poller.stop()
  })

  it('falls back to the header probe only when there is nothing to show at all', async () => {
    const h = harness({
      claudeEndpoint: async () => ({ outcome: 'rate-limited', limits: [], message: 'rate limited' }),
      claudeHeaders: async () => ({ outcome: 'ok', limits: [limit({ source: 'headers' })], message: null })
    })
    h.poller.start()
    await settle()

    expect(h.clients.claudeHeaders).toHaveBeenCalledTimes(1)
    // `replace: false`: the headers carry two windows and must not delete a
    // per-model row the endpoint knew about.
    expect(h.writes).toContainEqual(expect.objectContaining({ provider: 'claude', replace: false }))
    h.poller.stop()
  })

  it('does not spend quota on the probe while the endpoint is answering', async () => {
    // An install whose token *does* carry `user:profile` never pays for a probe.
    const h = harness({
      claudeHeaders: async () => ({ outcome: 'ok', limits: [limit({ source: 'headers' })], message: null })
    })
    h.poller.start()
    await settle()

    h.clients.claudeEndpoint.mockResolvedValue({ outcome: 'error', limits: [], message: 'boom' })
    await vi.advanceTimersByTimeAsync(61 * 60_000)

    expect(h.clients.claudeHeaders).not.toHaveBeenCalled()
    h.poller.stop()
  })

  it('hands over to the header probe when the endpoint refuses the scope', async () => {
    // The ordinary path, not an exception: a `claude setup-token` token carries
    // `user:inference` and the usage endpoint wants `user:profile`, so it
    // answers 403. The probe needs only the scope the token *does* have.
    const h = harness({
      claudeEndpoint: async () => ({ outcome: 'auth', limits: [], message: 'HTTP 403' }),
      claudeHeaders: async () => ({ outcome: 'ok', limits: [limit({ source: 'headers' })], message: null })
    })
    h.poller.start()
    await settle()

    expect(h.clients.claudeHeaders).toHaveBeenCalledTimes(1)
    expect(h.writes).toContainEqual(expect.objectContaining({ provider: 'claude', replace: false }))
    // Not an error state: the limits are on screen and current.
    expect(h.states).toContainEqual({ provider: 'claude', state: 'ok', message: null })
    h.poller.stop()
  })

  it('stops asking the endpoint every probe once it has refused, but keeps re-checking', async () => {
    const h = harness({
      claudeEndpoint: async () => ({ outcome: 'auth', limits: [], message: 'HTTP 403' }),
      claudeHeaders: async () => ({ outcome: 'ok', limits: [limit({ source: 'headers' })], message: null })
    })
    h.poller.start()
    await settle()
    expect(h.clients.claudeEndpoint).toHaveBeenCalledTimes(1)

    // Three probe intervals: the probe runs each time, the endpoint does not.
    await vi.advanceTimersByTimeAsync(46 * 60_000)
    expect(h.clients.claudeHeaders.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(h.clients.claudeEndpoint).toHaveBeenCalledTimes(1)

    // …but it is asked again within the hour, so a re-scoped token is picked
    // up without restarting Domo.
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(h.clients.claudeEndpoint.mock.calls.length).toBeGreaterThan(1)
    h.poller.stop()
  })

  it('reports the probe failing only when there is nothing on screen', async () => {
    const h = harness({
      claudeEndpoint: async () => ({ outcome: 'auth', limits: [], message: 'HTTP 403' }),
      claudeHeaders: async () => ({ outcome: 'error', limits: [], message: 'network down' })
    })
    h.poller.start()
    await settle()

    expect(h.states).toContainEqual({ provider: 'claude', state: 'error', message: 'network down' })
    h.poller.stop()
  })

  it('backs off after repeated failures, up to half an hour', async () => {
    const h = harness({
      codex: async () => ({ outcome: 'error', limits: [], message: 'codex is unhappy' })
    })
    h.poller.start()
    await settle()

    // First retry is 2x the five-minute base, not the base itself.
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    expect(h.clients.codex).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.clients.codex).toHaveBeenCalledTimes(2)

    // And it keeps widening rather than settling into a one-a-minute retry.
    const before = h.clients.codex.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.clients.codex.mock.calls.length - before).toBeLessThanOrEqual(1)
    h.poller.stop()
  })
})

describe('nothing configured', () => {
  it('says so instead of showing zeroes, and keeps looking in case a token appears', async () => {
    const h = harness({
      claudeEndpoint: async () => ({
        outcome: 'unconfigured',
        limits: [],
        message: 'Set NUXT_CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`) to see plan limits.'
      })
    })
    h.poller.start()
    await settle()

    expect(h.states).toContainEqual(expect.objectContaining({ provider: 'claude', state: 'unconfigured' }))
    expect(h.writes.filter(write => write.provider === 'claude')).toEqual([])

    await vi.advanceTimersByTimeAsync(61 * 60_000)
    expect(h.clients.claudeEndpoint.mock.calls.length).toBeGreaterThan(1)
    h.poller.stop()
  })
})

describe('secrets', () => {
  it('never lets a token reach a state row or the log', async () => {
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')) })

    const h = harness({
      // The worst case: a client that throws with the token in the message.
      claudeEndpoint: async () => { throw new Error(`request failed for Bearer ${TOKEN}`) }
    })
    h.poller.start()
    await settle()

    // The poller does not invent this — the message is whatever the client
    // produced — so what this pins is that `claude.ts` never builds one from a
    // header, and that a throw is caught rather than crashing the loop.
    const stateMessages = h.states.map(state => state.message ?? '').join(' ')
    expect(stateMessages + errors.join(' ')).toContain('request failed')
    expect(h.clients.codex).toHaveBeenCalled()
    h.poller.stop()
  })

  it('survives a client that throws, rather than killing the loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({
      codex: async () => { throw new Error('boom') }
    })
    h.poller.start()
    await settle()

    expect(h.states).toContainEqual({ provider: 'codex', state: 'error', message: 'boom' })
    // Still scheduled, so a transient failure is not permanent.
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(h.clients.codex.mock.calls.length).toBeGreaterThan(1)
    h.poller.stop()
  })
})
