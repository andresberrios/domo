import { bus } from '../bus'
import { listUsageLimits, setUsageProviderState, writeUsageLimits } from '../repo'
import { fetchClaudeUsage, probeClaudeHeaders, type ClaudeUsageResult } from './claude'
import { fetchCodexUsage, type CodexUsageResult } from './codex'
import { fetchOpenCodeUsage, type OpenCodeUsageResult } from './opencode'
import { fetchCopilotUsage, type CopilotUsageResult } from './copilot'
import type { UsageLimitValue } from './normalize'
import { usageResetPassed } from '../../../shared/usage-limits'
import type { UsageLimit, UsageProviderId, UsageProviderState } from '../../../shared/types'

/**
 * Keeping the account-wide limit rows current when nothing is talking.
 *
 * The limits belong to the developer, not to a session, so they have to be
 * right on a dashboard nobody has run an agent on today: this keeps every
 * signed-in provider current on its own schedule. A working agent does
 * refresh them for free — `_meta["_claude/rateLimit"]` rides in on
 * `usage_update` — but that only covers Claude, only while it works, and only
 * for the windows that event happens to name. This is the other half.
 */

/**
 * How often each source is asked, and why.
 *
 * Every source here is free to ask except one. `GET /api/oauth/usage`, Codex's
 * `account/rateLimits/read`, OpenCode Go's usage endpoint and GitHub's
 * `copilot_internal/user` are reads that spend nothing. The Claude header
 * probe is a real Messages request: one token in and one out of the plan it
 * measures, which is why it runs in minutes rather than seconds, and why it is
 * held back while a window is refusing and extra usage is on (that request
 * would be billed as extra usage). Grok's credits are not polled at all.
 *
 * `GET /api/oauth/usage` is asked at most hourly and mostly expected to fail:
 * a `claude setup-token` token lacks the `user:profile` scope it requires, so
 * it answers 403. It is still asked, because an operator with a
 * differently-scoped token gets a much richer answer from it, and at most
 * hourly because when it *does* work it is itself rate-limited to about one
 * call an hour (`retry-after: 3591` on the second). Between those calls the
 * probe keeps the two subscription windows current.
 */
const CLAUDE_ENDPOINT_MS = 60 * 60_000
const CLAUDE_PROBE_MS = 15 * 60_000
const CODEX_MS = 5 * 60_000
const OPENCODE_MS = 5 * 60_000
const COPILOT_MS = 5 * 60_000

const INTERVAL_MS: Record<UsageProviderId, number> = {
  claude: CLAUDE_PROBE_MS,
  codex: CODEX_MS,
  opencode: OPENCODE_MS,
  copilot: COPILOT_MS
}

/** Never more than one attempt per provider per minute, whoever asks. */
const FLOOR_MS = 60_000

/** A failing source backs off, but never past the point of giving up on it. */
const BACKOFF_CAP_MS = 30 * 60_000

/**
 * How often the poller checks what is due.
 *
 * Due times are wall-clock instants checked on this beat, not timers set for
 * the full interval: a Mac that sleeps pauses Node's timers, so a fifteen-minute
 * timer set before a night's sleep fires fifteen awake minutes after waking,
 * and the readings stay hours old meanwhile. A beat a minute catches up within
 * a minute of waking, and also notices a window whose reset has just passed.
 */
const TICK_MS = 60_000

/** A turn ending is a good moment to look, but several ending at once is not. */
const TURN_DEBOUNCE_MS = 5_000

/**
 * How old a reading may be before opening a usage view, or a turn ending,
 * asks for another one ahead of the schedule.
 */
export const USAGE_STALE_MS = 5 * 60_000

const PROVIDERS: UsageProviderId[] = ['claude', 'codex', 'opencode', 'copilot']

/** The network-facing half, injected so the tests never reach a real account. */
export interface UsageClients {
  claudeEndpoint: () => Promise<ClaudeUsageResult>
  claudeHeaders: () => Promise<ClaudeUsageResult>
  codex: () => Promise<CodexUsageResult>
  opencode: () => Promise<OpenCodeUsageResult>
  copilot: () => Promise<CopilotUsageResult>
}

/** The database-facing half, injected for the same reason. */
export interface UsageSink {
  writeLimits: (
    provider: UsageProviderId,
    limits: UsageLimitValue[],
    options: { replace: boolean }
  ) => Promise<void>
  setState: (provider: UsageProviderId, state: UsageProviderState, message: string | null) => Promise<void>
  /** Every row the provider has, whoever wrote it (a session event too). */
  listLimits: (provider: UsageProviderId) => Promise<UsageLimit[]>
}

export interface PollerOptions {
  clients?: Partial<UsageClients>
  sink?: Partial<UsageSink>
}

/**
 * What a caller wants.
 *
 * - nothing: a poll only if one is due, or a window has reset since the last
 *   look. The schedule's own beat.
 * - `ifOlderThanMs`: also when the last look is older than that. A view
 *   opening, or a turn ending.
 * - `force`: now. The refresh button.
 *
 * None of them skips the one-a-minute floor, or a `Retry-After` the provider
 * itself asked for.
 */
export interface UsageRequest {
  force?: boolean
  ifOlderThanMs?: number
}

const defaultClients: UsageClients = {
  claudeEndpoint: () => fetchClaudeUsage(),
  claudeHeaders: () => probeClaudeHeaders(),
  codex: () => fetchCodexUsage(),
  opencode: () => fetchOpenCodeUsage(),
  copilot: () => fetchCopilotUsage()
}

const defaultSink: UsageSink = {
  writeLimits: (provider, limits, options) => writeUsageLimits(provider, limits, options),
  setState: (provider, state, message) => setUsageProviderState(provider, state, message),
  listLimits: provider => listUsageLimits(provider)
}

interface ProviderState {
  /** In flight, so every other caller joins it rather than starting a second one. */
  running: Promise<void> | null
  lastAttemptAt: number
  /** Wall-clock time of the next scheduled poll. */
  nextDueAt: number
  /** Consecutive failures, for the backoff. */
  failures: number
  /** Set by a `Retry-After` on the probe (or a whole provider): nothing may ask before this. */
  blockedUntil: number
  /** The same for Claude's usage endpoint alone, which is rate-limited on its own. */
  endpointBlockedUntil: number
  /**
   * When the usage endpoint was last asked. It answers about once an hour,
   * and a headless token gets a 403 from it: asking hourly is what stops the
   * poller spending a 403 every probe to learn the same thing, while a
   * re-scoped token is still picked up without a restart.
   */
  lastEndpointAt: number
}

function newProviderState(): ProviderState {
  return {
    running: null,
    lastAttemptAt: 0,
    nextDueAt: 0,
    failures: 0,
    blockedUntil: 0,
    endpointBlockedUntil: 0,
    lastEndpointAt: 0
  }
}

/** Claude's subscription windows: a refusal in one of them is what extra usage pays for. */
const CLAUDE_WINDOWS = new Set(['five_hour', 'seven_day', 'seven_day_overage_included'])

/**
 * When a probe would be billed as extra usage, the time it stops being so.
 *
 * A subscription window that is refusing, on an account with extra usage on,
 * serves the probe's request from extra usage: money, however little. The
 * reading cannot change before the window resets anyway, and a working agent
 * reports it for free meanwhile, so the probe waits for the reset.
 */
function paidProbeUntil(rows: UsageLimit[], now: number): number | null {
  const extra = rows.find(row => row.limitId === 'extra_usage')
  if (!extra || extra.status === 'off' || extra.status === null) return null
  let until: number | null = null
  for (const row of rows) {
    if (!CLAUDE_WINDOWS.has(row.limitId) || usageResetPassed(row, now)) continue
    if (row.status !== 'rejected' && (row.usedPercent ?? 0) < 100) continue
    const resetsAt = row.resetsAt ? Date.parse(row.resetsAt) : Number.NaN
    const end = Number.isNaN(resetsAt) ? now + CLAUDE_ENDPOINT_MS : resetsAt
    until = Math.max(until ?? 0, end)
  }
  return until
}

export class UsagePoller {
  private readonly clients: UsageClients
  private readonly sink: UsageSink
  private readonly state = new Map<UsageProviderId, ProviderState>()
  private stopped = true
  private unsubscribe: (() => void) | null = null
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(options: PollerOptions = {}) {
    this.clients = { ...defaultClients, ...options.clients }
    this.sink = { ...defaultSink, ...options.sink }
    for (const provider of PROVIDERS) this.state.set(provider, newProviderState())
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    // A turn ending is when the numbers have just moved, so it looks again
    // when the last look is a few minutes old. Debounced: three agents
    // finishing together is one look.
    this.unsubscribe = bus.subscribe((event) => {
      if (event.type !== 'agent-event' || event.event.type !== 'turn_end') return
      if (this.turnTimer) return
      this.turnTimer = setTimeout(() => {
        this.turnTimer = null
        for (const provider of PROVIDERS) void this.request(provider, { ifOlderThanMs: USAGE_STALE_MS })
      }, TURN_DEBOUNCE_MS)
      this.turnTimer.unref?.()
    })
    this.ticker = setInterval(() => this.tick(), TICK_MS)
    this.ticker.unref?.()
    this.tick()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  private tick(): void {
    for (const provider of PROVIDERS) void this.request(provider)
  }

  /** Ask for a poll, if one is wanted and allowed (see `UsageRequest`). */
  request(provider: UsageProviderId, options: UsageRequest = {}): Promise<void> {
    if (this.stopped && !options.force) return Promise.resolve()
    const state = this.state.get(provider)!
    if (state.running) return state.running
    const run = this.attempt(provider, state, options)
      .catch(error => console.error(`[usage] ${provider} request failed`, error))
      .finally(() => { state.running = null })
    state.running = run
    return run
  }

  private async attempt(provider: UsageProviderId, state: ProviderState, options: UsageRequest): Promise<void> {
    const now = Date.now()
    if (now < state.blockedUntil) return
    if (state.lastAttemptAt !== 0 && now - state.lastAttemptAt < FLOOR_MS) return
    if (!options.force) {
      const stale = options.ifOlderThanMs !== undefined && now - state.lastAttemptAt >= options.ifOlderThanMs
      if (!stale && now < state.nextDueAt && !(await this.resetSinceLastLook(provider, state, now))) return
    }
    state.lastAttemptAt = now
    await this.poll(provider, state, options.force === true)
  }

  /**
   * Whether a window this provider reported has reset since the last look.
   *
   * Then the reading on screen is known to be out of date, so it is due now.
   * Once per reset: a window the source does not report again (Claude's
   * Fable week comes only from session events) is not asked about every minute.
   */
  private async resetSinceLastLook(provider: UsageProviderId, state: ProviderState, now: number): Promise<boolean> {
    const rows = await this.sink.listLimits(provider)
    return rows.some(row => usageResetPassed(row, now) && Date.parse(row.resetsAt!) > state.lastAttemptAt)
  }

  private succeeded(state: ProviderState, interval: number): void {
    state.failures = 0
    state.nextDueAt = Date.now() + interval
  }

  /** Every failure lengthens the wait, up to half an hour. */
  private failed(state: ProviderState, base: number): void {
    state.failures++
    state.nextDueAt = Date.now() + Math.min(BACKOFF_CAP_MS, base * 2 ** Math.min(state.failures, 5))
  }

  private async poll(provider: UsageProviderId, state: ProviderState, force: boolean): Promise<void> {
    try {
      if (provider === 'codex') await this.pollCodex(state)
      else if (provider === 'opencode') await this.pollAccount('opencode', state, OPENCODE_MS)
      else if (provider === 'copilot') await this.pollAccount('copilot', state, COPILOT_MS)
      else await this.pollClaude(state, force)
    } catch (error) {
      // Nothing may throw out of a poll: the next one is only due if this one
      // says when.
      const message = error instanceof Error ? (error.message || error.name) : String(error)
      console.error(`[usage] ${provider} poll failed: ${message}`)
      this.failed(state, INTERVAL_MS[provider])
      await this.sink.setState(provider, 'error', message).catch(() => {})
    }
  }

  private async pollClaude(state: ProviderState, force: boolean): Promise<void> {
    // The endpoint is the better answer when it works (the only source of the
    // per-model weekly buckets and the credits balance), so it is asked
    // whenever it can be: hourly, and hourly again after it has refused, in
    // case the operator supplies a token that carries `user:profile`.
    const now = Date.now()
    const askEndpoint = now >= state.endpointBlockedUntil
      && (state.lastEndpointAt === 0 || now - state.lastEndpointAt >= CLAUDE_ENDPOINT_MS)
    let endpointMessage: string | null = null

    if (askEndpoint) {
      state.lastEndpointAt = now
      const result = await this.clients.claudeEndpoint()

      if (result.outcome === 'ok') {
        state.endpointBlockedUntil = 0
        this.succeeded(state, CLAUDE_PROBE_MS)
        await this.sink.writeLimits('claude', result.limits, { replace: true })
        await this.sink.setState('claude', 'ok', result.message)
        return
      }

      if (result.outcome === 'unconfigured') {
        // Still on the clock, so a token added later is picked up without a restart.
        state.failures = 0
        state.nextDueAt = now + CLAUDE_ENDPOINT_MS
        state.lastEndpointAt = 0
        await this.sink.setState('claude', 'unconfigured', result.message)
        return
      }

      // `auth` is the expected answer for a `claude setup-token` token. The
      // probe below needs only the inference scope that token *does* have, so
      // that is a handover rather than a failure.
      if (result.outcome !== 'auth') {
        // Rate-limited or broken. That holds back the endpoint only; the probe
        // is a different request and still answers.
        if (result.retryAfterMs !== undefined) state.endpointBlockedUntil = now + result.retryAfterMs
        endpointMessage = result.message
      }
    }

    await this.probeClaudeLimits(state, force, endpointMessage)
  }

  /**
   * Read the limits off a minimal request's rate-limit headers.
   *
   * `replace: false`: the headers carry the two subscription windows and
   * nothing else, so they must never delete a per-model row or a credits row
   * the endpoint knew about on an install where the endpoint does work.
   */
  private async probeClaudeLimits(state: ProviderState, force: boolean, endpointMessage: string | null): Promise<void> {
    const rows = await this.sink.listLimits('claude')
    const paidUntil = force ? null : paidProbeUntil(rows, Date.now())
    if (paidUntil !== null) {
      // Not a failure: there is nothing to learn that would not cost money.
      state.failures = 0
      state.nextDueAt = paidUntil
      return
    }

    const probe = await this.clients.claudeHeaders()

    if (probe.outcome === 'ok') {
      this.succeeded(state, CLAUDE_PROBE_MS)
      await this.sink.writeLimits('claude', probe.limits, { replace: false })
      await this.sink.setState('claude', 'ok', null)
      return
    }

    if (probe.outcome === 'unconfigured') {
      state.failures = 0
      state.nextDueAt = Date.now() + CLAUDE_ENDPOINT_MS
      await this.sink.setState('claude', 'unconfigured', probe.message)
      return
    }

    if (probe.retryAfterMs !== undefined) state.blockedUntil = Date.now() + probe.retryAfterMs
    this.failed(state, CLAUDE_PROBE_MS)
    // A failing probe backs off, but not past the endpoint's next hourly turn.
    state.nextDueAt = Math.min(state.nextDueAt, Math.max(state.lastEndpointAt + CLAUDE_ENDPOINT_MS, state.endpointBlockedUntil))
    // Keep whatever is on the table: the rows carry their own timestamp and
    // the UI says how old they are. Only say why it is not moving.
    await this.sink.setState('claude', rows.length > 0 ? 'ok' : 'error', probe.message ?? endpointMessage)
  }

  private async pollCodex(state: ProviderState): Promise<void> {
    const result = await this.clients.codex()
    if (result.outcome === 'ok') {
      this.succeeded(state, CODEX_MS)
      await this.sink.writeLimits('codex', result.limits, { replace: true })
      await this.sink.setState('codex', 'ok', null)
      return
    }
    if (result.outcome === 'unconfigured') {
      this.succeeded(state, CODEX_MS)
      await this.sink.setState('codex', 'unconfigured', result.message)
      return
    }
    this.failed(state, CODEX_MS)
    await this.sink.setState('codex', 'error', result.message)
  }

  /** An account endpoint that answers every window at once: OpenCode Go's, and Copilot's. */
  private async pollAccount(provider: 'opencode' | 'copilot', state: ProviderState, interval: number): Promise<void> {
    const result = await this.clients[provider]()
    if (result.outcome === 'ok') {
      this.succeeded(state, interval)
      await this.sink.writeLimits(provider, result.limits, { replace: true })
      await this.sink.setState(provider, 'ok', null)
      return
    }
    if (result.outcome === 'error') this.failed(state, interval)
    else this.succeeded(state, interval)
    await this.sink.setState(provider, result.outcome === 'unconfigured' ? 'unconfigured' : 'error', result.message)
  }
}

const globalKey = '__domo_usage_poller__'
const g = globalThis as any
export const usagePoller: UsagePoller = g[globalKey] ?? (g[globalKey] = new UsagePoller())
