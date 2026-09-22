import { bus } from '../bus'
import { listUsageLimits, setUsageProviderState, writeUsageLimits } from '../repo'
import { fetchClaudeUsage, probeClaudeHeaders, type ClaudeUsageResult } from './claude'
import { fetchCodexUsage, type CodexUsageResult } from './codex'
import { fetchOpenCodeUsage, type OpenCodeUsageResult } from './opencode'
import type { UsageLimitValue } from './normalize'
import type { UsageProviderId, UsageProviderState } from '../../../shared/types'

/**
 * Keeping the account-wide limit rows current when nothing is talking.
 *
 * The limits belong to the developer, not to a session, so they have to be
 * right on a dashboard nobody has run an agent on today. A working agent does
 * refresh them for free — `_meta["_claude/rateLimit"]` rides in on
 * `usage_update` — but that only covers Claude, only while it works, and only
 * for the windows that event happens to name. This is the other half.
 */

/**
 * How often each source is asked, and why.
 *
 * Both Claude intervals are measurements rather than preferences.
 *
 * `GET /api/oauth/usage` is asked hourly and mostly expected to fail: a
 * `claude setup-token` token lacks the `user:profile` scope it requires, so it
 * answers 403. It is still asked, because an operator with a differently-scoped
 * token gets a much richer answer from it — and hourly because when it *does*
 * work it is itself rate-limited to about one call an hour
 * (`retry-after: 3591` on the second).
 *
 * The header probe is therefore the source that actually carries this feature.
 * It costs one token in and one token out of the very plan it is measuring,
 * which is cheap but not free, so it runs in minutes rather than seconds.
 *
 * Codex costs nothing but a short-lived local process, so it can afford minutes.
 */
const CLAUDE_ENDPOINT_MS = 60 * 60_000
const CLAUDE_PROBE_MS = 15 * 60_000
const CODEX_MS = 5 * 60_000
const OPENCODE_MS = 5 * 60_000

/** Never more than one attempt per provider per minute, whoever asks. */
const FLOOR_MS = 60_000

/** A failing source backs off, but never past the point of giving up on it. */
const BACKOFF_CAP_MS = 30 * 60_000

/** A turn ending is a good moment to look, but several ending at once is not. */
const TURN_DEBOUNCE_MS = 5_000

const PROVIDERS: UsageProviderId[] = ['claude', 'codex', 'opencode']

/** The network-facing half, injected so the tests never reach a real account. */
export interface UsageClients {
  claudeEndpoint: () => Promise<ClaudeUsageResult>
  claudeHeaders: () => Promise<ClaudeUsageResult>
  codex: () => Promise<CodexUsageResult>
  opencode: () => Promise<OpenCodeUsageResult>
}

/** The database-facing half, injected for the same reason. */
export interface UsageSink {
  writeLimits: (
    provider: UsageProviderId,
    limits: UsageLimitValue[],
    options: { replace: boolean }
  ) => Promise<void>
  setState: (provider: UsageProviderId, state: UsageProviderState, message: string | null) => Promise<void>
  countLimits: (provider: UsageProviderId) => Promise<number>
}

export interface PollerOptions {
  clients?: Partial<UsageClients>
  sink?: Partial<UsageSink>
}

const defaultClients: UsageClients = {
  claudeEndpoint: () => fetchClaudeUsage(),
  claudeHeaders: () => probeClaudeHeaders(),
  codex: () => fetchCodexUsage(),
  opencode: () => fetchOpenCodeUsage()
}

const defaultSink: UsageSink = {
  writeLimits: (provider, limits, options) => writeUsageLimits(provider, limits, options),
  setState: (provider, state, message) => setUsageProviderState(provider, state, message),
  countLimits: async provider => (await listUsageLimits(provider)).length
}

interface ProviderState {
  timer: ReturnType<typeof setTimeout> | null
  /** In flight, so a manual refresh joins it rather than starting a second one. */
  running: Promise<void> | null
  lastAttemptAt: number
  /** Consecutive failures, for the backoff. */
  failures: number
  /** Set by a `Retry-After`: nothing may ask again before this. */
  blockedUntil: number
  /** When the quota-spending header probe last ran. */
  lastProbeAt: number
  /**
   * When the usage endpoint last said the token cannot use it.
   *
   * The ordinary case, not an exception: a headless token has no
   * `user:profile`. Remembering it is what stops the poller spending an hourly
   * 403 to learn the same thing, while still re-checking often enough that a
   * re-scoped token is picked up without a restart.
   */
  endpointRefusedAt: number
}

function newProviderState(): ProviderState {
  return {
    timer: null,
    running: null,
    lastAttemptAt: 0,
    failures: 0,
    blockedUntil: 0,
    lastProbeAt: 0,
    endpointRefusedAt: 0
  }
}

export class UsagePoller {
  private readonly clients: UsageClients
  private readonly sink: UsageSink
  private readonly state = new Map<UsageProviderId, ProviderState>()
  private stopped = true
  private unsubscribe: (() => void) | null = null
  private turnTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: PollerOptions = {}) {
    this.clients = { ...defaultClients, ...options.clients }
    this.sink = { ...defaultSink, ...options.sink }
    for (const provider of PROVIDERS) this.state.set(provider, newProviderState())
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    // A turn ending is when the numbers have just moved, so it is the one event
    // worth reacting to. Debounced: three agents finishing together is one look.
    this.unsubscribe = bus.subscribe((event) => {
      if (event.type !== 'agent-event' || event.event.type !== 'turn_end') return
      if (this.turnTimer) return
      this.turnTimer = setTimeout(() => {
        this.turnTimer = null
        for (const provider of PROVIDERS) void this.request(provider)
      }, TURN_DEBOUNCE_MS)
      this.turnTimer.unref?.()
    })
    for (const provider of PROVIDERS) void this.request(provider)
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    for (const state of this.state.values()) {
      if (state.timer) clearTimeout(state.timer)
      state.timer = null
    }
  }

  /**
   * Ask for a poll now, if it is allowed to happen.
   *
   * `force` is the refresh button: it skips the ordinary interval, because the
   * person pressing it knows the reading is stale. It does *not* skip the
   * one-a-minute floor, and it does not skip a `Retry-After` the provider
   * itself asked for — a refused request would answer the same staleness with
   * a 429 and teach nobody anything.
   */
  async request(provider: UsageProviderId, options: { force?: boolean } = {}): Promise<void> {
    if (this.stopped && !options.force) return
    const state = this.state.get(provider)!
    if (state.running) return state.running

    const now = Date.now()
    if (now < state.blockedUntil) return
    if (now - state.lastAttemptAt < FLOOR_MS && state.lastAttemptAt !== 0) return
    state.lastAttemptAt = now
    const run = this.poll(provider, state).finally(() => { state.running = null })
    state.running = run
    return run
  }

  private schedule(provider: UsageProviderId, delay: number): void {
    if (this.stopped) return
    const state = this.state.get(provider)!
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      void this.request(provider)
    }, Math.max(FLOOR_MS, delay))
    state.timer.unref?.()
  }

  /** Every failure lengthens the wait, up to half an hour. */
  private backoff(state: ProviderState, base: number): number {
    if (state.failures === 0) return base
    return Math.min(BACKOFF_CAP_MS, base * 2 ** Math.min(state.failures, 5))
  }

  private async poll(provider: UsageProviderId, state: ProviderState): Promise<void> {
    try {
      if (provider === 'codex') await this.pollCodex(state)
      else if (provider === 'opencode') await this.pollOpenCode(state)
      else await this.pollClaude(state)
    } catch (error) {
      // Nothing may throw out of a poll: the timer that scheduled it is the
      // only thing keeping the loop alive.
      state.failures++
      const message = error instanceof Error ? (error.message || error.name) : String(error)
      console.error(`[usage] ${provider} poll failed: ${message}`)
      await this.sink.setState(provider, 'error', message).catch(() => {})
      const interval = provider === 'claude' ? CLAUDE_ENDPOINT_MS : provider === 'codex' ? CODEX_MS : OPENCODE_MS
      this.schedule(provider, this.backoff(state, interval))
    }
  }

  private async pollClaude(state: ProviderState): Promise<void> {
    // The endpoint is the better answer when it works — it is the only source
    // that reports per-model weekly buckets and the credits balance — so it is
    // tried first, and re-tried hourly even after it has refused, in case the
    // operator supplies a token that carries `user:profile`.
    const askEndpoint = state.endpointRefusedAt === 0
      || Date.now() - state.endpointRefusedAt >= CLAUDE_ENDPOINT_MS

    if (askEndpoint) {
      const result = await this.clients.claudeEndpoint()

      if (result.outcome === 'ok') {
        state.failures = 0
        state.blockedUntil = 0
        state.endpointRefusedAt = 0
        await this.sink.writeLimits('claude', result.limits, { replace: true })
        await this.sink.setState('claude', 'ok', result.message)
        this.schedule('claude', CLAUDE_ENDPOINT_MS)
        return
      }

      if (result.outcome === 'unconfigured') {
        state.failures = 0
        await this.sink.setState('claude', 'unconfigured', result.message)
        // Still on the clock, so a token added later is picked up without a restart.
        this.schedule('claude', CLAUDE_ENDPOINT_MS)
        return
      }

      if (result.outcome === 'auth') {
        // The expected path for a `claude setup-token` token. The probe below
        // needs only the inference scope that token *does* have, so this is a
        // handover rather than a failure.
        state.endpointRefusedAt = Date.now()
      } else {
        // Rate-limited or broken. Whatever is already on the table is still
        // true — the rows carry their own timestamp and the UI says how old
        // they are — so nothing is replaced with nothing.
        if (result.retryAfterMs !== undefined) state.blockedUntil = Date.now() + result.retryAfterMs
        if (await this.sink.countLimits('claude') > 0) {
          state.failures++
          await this.sink.setState('claude', 'ok', result.message)
          this.schedule('claude', result.retryAfterMs ?? this.backoff(state, CLAUDE_ENDPOINT_MS))
          return
        }
      }
    }

    await this.probeClaudeLimits(state)
  }

  /**
   * Read the limits off a minimal request's rate-limit headers.
   *
   * `replace: false`: the headers carry the two subscription windows and
   * nothing else, so they must never delete a per-model row or a credits row
   * the endpoint knew about on an install where the endpoint does work.
   */
  private async probeClaudeLimits(state: ProviderState): Promise<void> {
    state.lastProbeAt = Date.now()
    const probe = await this.clients.claudeHeaders()

    if (probe.outcome === 'ok') {
      state.failures = 0
      await this.sink.writeLimits('claude', probe.limits, { replace: false })
      await this.sink.setState('claude', 'ok', null)
      this.schedule('claude', CLAUDE_PROBE_MS)
      return
    }

    if (probe.outcome === 'unconfigured') {
      state.failures = 0
      await this.sink.setState('claude', 'unconfigured', probe.message)
      this.schedule('claude', CLAUDE_ENDPOINT_MS)
      return
    }

    state.failures++
    // Keep whatever is on the table; say why it is not moving.
    const known = await this.sink.countLimits('claude')
    await this.sink.setState('claude', known > 0 ? 'ok' : 'error', probe.message)
    this.schedule('claude', this.backoff(state, CLAUDE_PROBE_MS))
  }

  private async pollCodex(state: ProviderState): Promise<void> {
    const result = await this.clients.codex()
    if (result.outcome === 'ok') {
      state.failures = 0
      await this.sink.writeLimits('codex', result.limits, { replace: true })
      await this.sink.setState('codex', 'ok', null)
      this.schedule('codex', CODEX_MS)
      return
    }
    if (result.outcome === 'unconfigured') {
      state.failures = 0
      await this.sink.setState('codex', 'unconfigured', result.message)
      this.schedule('codex', CODEX_MS)
      return
    }
    state.failures++
    await this.sink.setState('codex', 'error', result.message)
    this.schedule('codex', this.backoff(state, CODEX_MS))
  }

  private async pollOpenCode(state: ProviderState): Promise<void> {
    const result = await this.clients.opencode()
    if (result.outcome === 'ok') {
      state.failures = 0
      await this.sink.writeLimits('opencode', result.limits, { replace: true })
      await this.sink.setState('opencode', 'ok', null)
      this.schedule('opencode', OPENCODE_MS)
      return
    }
    state.failures += result.outcome === 'error' ? 1 : 0
    await this.sink.setState('opencode', result.outcome === 'unconfigured' ? 'unconfigured' : 'error', result.message)
    this.schedule('opencode', result.outcome === 'error' ? this.backoff(state, OPENCODE_MS) : OPENCODE_MS)
  }
}

const globalKey = '__domo_usage_poller__'
const g = globalThis as any
export const usagePoller: UsagePoller = g[globalKey] ?? (g[globalKey] = new UsagePoller())
