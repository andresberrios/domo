/**
 * Keep a pull-wake runner alive across transient agents-server outages.
 *
 * `createPullWakeRunner.run()` (agents-runtime) is a *single pass*: it
 * opens the wake stream once and consumes it with `for await`; when that
 * stream ends or errors (agents-server crash/redeploy, or — as seen in
 * prod — durable-streams briefly saturated by a runaway entity, which
 * also 502s the heartbeat) `run()` falls through its `finally`
 * (`stopHeartbeat()`, `loop = null`) and **nothing restarts it**. The
 * `onError` hook only suppresses a throw; it does not reconnect. So a
 * brief blip otherwise permanently kills wake delivery for every entity
 * until a manual `domo restart` — the exact prod incident this fixes.
 *
 * The runner instance is *reused* across reconnects, so it resumes from
 * its internal `currentOffset` (the last consumed wake) — the same
 * offset-replay the restart-resume design relies on; recreating it would
 * reset to the server offset and skip/replay. Exponential backoff
 * (1s→30s) under a sustained outage; reset after the runner stays
 * healthy a while so a transient blip recovers fast.
 *
 * Extracted from runtime.ts as a pure helper (only a type import) so the
 * resilience logic is one reviewable, independently testable unit — see
 * smoke/runner-supervisor-resume.mjs.
 */
import type { PullWakeRunner } from '@electric-ax/agents-runtime'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface SuperviseOptions {
  /**
   * Re-assert the runner with agents-server before each reconnect
   * (idempotent upsert — covers an agents-server that restarted and
   * lost runner state). Must NOT recreate the runner: the reused
   * instance resumes from its own offset.
   */
  reassert: () => Promise<void>
  /**
   * True when the supervisor should exit for good (intentional stop, or
   * this runner is no longer the active one). Checked after every await.
   */
  isDone: () => boolean
  /** Defaults to console.{log,warn,error}. Injectable for tests. */
  log?: (msg: string) => void
  warn?: (msg: string) => void
  error?: (msg: string, err: unknown) => void
  /** Backoff knobs (defaults: 1s / 30s / 60s). Overridable for tests. */
  minMs?: number
  maxMs?: number
  healthyMs?: number
}

/**
 * Supervise `runner` until `isDone()`. The caller is expected to have
 * already `runner.start()`ed it (steady state goes straight to
 * `waitForStopped()`); on an *unexpected* end this reconnects with
 * backoff. Resolves when `isDone()` becomes true.
 */
export async function superviseRunnerLoop(
  runner: PullWakeRunner,
  opts: SuperviseOptions,
): Promise<void> {
  const minMs = opts.minMs ?? 1000
  const maxMs = opts.maxMs ?? 30_000
  const healthyMs = opts.healthyMs ?? 60_000
  const log = opts.log ?? ((m) => console.log(m))
  const warn = opts.warn ?? ((m) => console.warn(m))
  const error =
    opts.error ?? ((m, e) => console.error(m, e))

  let backoff = minMs
  // The runner is already .start()ed by the caller; treat now as the
  // start of the first healthy window.
  let connectedAt = Date.now()
  for (;;) {
    // (Re)connect whenever the runner isn't running. start() is a
    // no-op while a loop is live, so the steady state skips straight
    // to waitForStopped() below.
    if (!runner.running) {
      await sleep(backoff)
      if (opts.isDone()) return
      try {
        await opts.reassert()
        runner.start()
        if (opts.isDone()) {
          await runner.stop().catch(() => {})
          return
        }
        connectedAt = Date.now()
        log('[electric] pull-wake runner reconnected')
      } catch (err) {
        error('[electric] pull-wake runner reconnect failed:', err)
        backoff = Math.min(backoff * 2, maxMs)
        continue
      }
    }
    await runner.waitForStopped().catch(() => {})
    if (opts.isDone()) return
    const uptimeMs = Date.now() - connectedAt
    // Healthy for a while → fresh incident, recover fast. Otherwise
    // it's flapping → escalate backoff.
    backoff =
      uptimeMs >= healthyMs ? minMs : Math.min(backoff * 2, maxMs)
    warn(
      `[electric] pull-wake runner ended unexpectedly (uptime ` +
        `${Math.round(uptimeMs / 1000)}s); reconnecting in ${backoff}ms`,
    )
  }
}
