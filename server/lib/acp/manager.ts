import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { bus } from '../bus'
import { adapterCommandPath } from '../dev-env/runtime-volume'
import {
  containerExecArgs,
  ensureEnvironmentRunning,
  readEnvironmentFile,
  writeEnvironmentFile
} from '../dev-environments'
import { browserMcpServer } from '../dev-env/browser-volume'
import { internalBaseUrl } from '../internal-url'
import { mintMeshToken } from '../mesh/token'
import { normalizeCwd } from '../paths'
import { getSettings } from '../settings'
import { adapterEnv, adapterLaunch } from './adapter-process'
import { assertSessionLive } from './retirement'
import { claudeSessionLimits, normalizeAgentUsage, sameAgentUsage, type UsageLimitValue } from '../usage/normalize'
import { combineInboxContent } from './inbox'
import {
  adapterConfigOptions,
  configValueIds,
  findConfigOption,
  resolveConfigValue,
  sameConfigOptions
} from './config-options'
import { availableModelIds, currentModel, defaultModel, modelConfigOption, resolveModel } from './model'
import { availableModes, currentModeId, modeConfigOption } from './mode'
import {
  appendAgentEvent,
  claimInboxMessages,
  createAgentSession,
  createPermission,
  enqueueInboxMessage,
  getAgentSession,
  listAgentSessions,
  listMcpServers,
  openAgentStream,
  resolvePermissionRow,
  setAgentUsage,
  updateAgentSession,
  writeAgentStream,
  writeUsageLimits
} from '../repo'
import type {
  AgentAdapter,
  AgentEvent,
  AgentSession,
  AgentSessionStatus,
  AgentStreamType,
  AgentUsage,
  AppSettings,
  DevEnvironment,
  MessageDelivery,
  MessageOrigin,
  PendingPermission,
  SessionConfigOptionInfo
} from '../../../shared/types'

interface PendingPermissionWaiter {
  permission: PendingPermission
  resolve: (optionId: string | null) => void
}

/**
 * The extension request both installed adapters take to inject a message into
 * the turn that is already running.
 *
 * This is *not* a core ACP method and not an `agentCapabilities` entry: it is
 * advertised in the `initialize` response's top-level `_meta.steering.supported`
 * and named by the agreed steering wire protocol. Sending it to an adapter that
 * does not advertise it would be a bare "method not found".
 */
const STEERING_METHOD = '_session/steering'

/**
 * Ask the adapter to hand a steer back rather than start a turn of its own when
 * the session turns out to be idle.
 *
 * Without it, an idle steer starts a turn the adapter owns: its output streams
 * through `session/update` but nothing ever resolves a `session/prompt`, so
 * Domo would never see the turn end and would never drain the inbox behind it.
 * The Claude adapter honours the opt-in and answers `{ outcome:
 * 'promptRequired' }`; codex-acp accepts the `_meta` and ignores it, which is
 * why the decision of whether a turn is running is Domo's own and the steering
 * request is only ever sent when Domo has one in flight.
 */
const STEERING_META = { steering: { idleBehavior: 'promptRequired' } }

/** A turn Domo started and is waiting on. */
interface Turn {
  cancel: () => void
  /** Resolves once the turn has settled, however it settled. */
  done: Promise<void>
  /** Set by an `interrupt` delivery: the abort is deliberate, not a failure. */
  interrupted: boolean
}

/** What a delivery ended up doing, after the fallbacks. */
export interface DeliveryResult {
  /** The mode that actually applied — `steer` becomes `interrupt` without support. */
  delivery: MessageDelivery
  outcome: 'prompted' | 'steered' | 'queued'
  /** The `agent_inbox` row, when the message is waiting. */
  inboxId?: string
}

/** A run of streaming text that is being coalesced into one `agent_events` row. */
interface StreamBlock {
  type: AgentStreamType
  /** Everything received so far. */
  text: string
  /** What the row already holds, so an idle flush writes nothing. */
  written: string
  /** The insert that claimed the row's `seq`; every write waits on it. */
  row: Promise<AgentEvent>
  timer: ReturnType<typeof setTimeout> | null
}

const FLUSH_MS = 150
/** Past this, a flush costs more than it buys; see `flushDelay`. */
const FLUSH_SOFT_LIMIT = 4096
const FLUSH_MAX_MS = 2000

/**
 * How long to wait before writing the deltas received so far.
 *
 * Every write re-streams the whole row to the browser (Electric, plus
 * `REPLICA IDENTITY FULL`), so a fixed interval costs O(length^2 / interval)
 * bytes over a block: fine for the couple of kilobytes a message usually is,
 * wasteful for a long one. The interval therefore grows with the block once it
 * is past a few kilobytes, which caps the total at a few times its final size.
 */
function flushDelay(length: number): number {
  return Math.min(FLUSH_MAX_MS, Math.max(FLUSH_MS, Math.round((FLUSH_MS * length) / FLUSH_SOFT_LIMIT)))
}

/**
 * How often a working agent refreshes `last_activity_at`.
 *
 * It is not decoration: `list_agent_sessions` reports it to the voice agent,
 * which is told to pick "the most recently active agent" for a vague
 * instruction. Left to status transitions alone, an agent streaming for twenty
 * minutes would look like the stalest one in the list and Domo would hand the
 * user's "keep going" to the wrong session.
 */
const ACTIVITY_TOUCH_MS = 30_000

/**
 * How often the context-window reading is written mid-turn.
 *
 * `usage_update` arrives with every `message_delta` — several times a second on
 * a long answer — and `agent_sessions` is synced with `REPLICA IDENTITY FULL`,
 * so writing each one would re-stream the whole session row to every browser
 * for a number that moved by forty tokens. The bar still has to *move* while
 * the agent works, so this is a few seconds rather than a turn.
 */
const USAGE_WRITE_MS = 5_000

/**
 * How often a plan-limit reading that rode in on a `usage_update` is written.
 *
 * Same problem as `USAGE_WRITE_MS` and the same answer, against a different
 * table. `_meta["_claude/rateLimit"]` is attached to the same per-delta event,
 * so an un-throttled write path would rewrite an account-wide `usage_limits`
 * row several times a second on a long answer — and that table is
 * `REPLICA IDENTITY FULL` too, so each one re-streams to every open browser.
 *
 * Debounced here rather than guarded inside `writeUsageLimits`, because the
 * frequency is this path's problem: the poller wants every one of its (rare)
 * checks written, including a check that confirms the same number, or the
 * "as of X ago" caption lies about when it last looked.
 */
const PLAN_LIMIT_WRITE_MS = 5_000

/**
 * What a `mode_changed` / `model_changed` / `config_changed` event says about
 * a setting that was recorded with no adapter running to take it.
 *
 * The event itself still belongs in the log: somebody *did* change the
 * setting, and a transcript that shows the mode changing under it is the only
 * account of why the next turn behaves differently. What it must not do is
 * claim more than happened. A setting applied to a live adapter is a fact
 * about the process; one written to a stopped session is a request the next
 * attach will make — so the second kind is marked, and the transcript renders
 * it as "when it next starts".
 *
 * Absent rather than `false` on the ordinary path: the payloads are what the
 * UI reads and what a person reads in the database, and every event that is
 * not marked is one that took.
 */
function pendingMark(live: boolean): { pending?: true } {
  return live ? {} : { pending: true }
}

class AgentRuntime {
  readonly agentSessionId: string
  private proc: ChildProcessWithoutNullStreams | null = null
  private connection: acp.ClientConnection | null = null
  private acpSessionId: string | null = null
  private booting: Promise<void> | null = null
  private waiters = new Map<string, PendingPermissionWaiter>()
  /**
   * The turn in flight, claimed synchronously by `prompt`.
   *
   * `deliver` reads it to decide whether a message steers, queues or
   * interrupts, so an async gap between claiming it and sending the request
   * would make a turn that is already Domo's look idle.
   */
  private turn: Turn | null = null
  /** Whether the adapter advertised `_session/steering`; per connection. */
  private steering = false
  /**
   * Whether this connection is still restoring a session it was handed, in
   * which case nothing it says is news.
   *
   * `session/load` restores the *adapter's* transcript, and the way an adapter
   * does that is by replaying its history as ordinary `session/update`
   * notifications: claude-agent-acp's `replaySessionHistory` and codex-acp's
   * `streamThreadHistory` both run to completion inside the load request, so
   * every update in that window is a second copy of something `agent_events`
   * already holds. Appended, they became a duplicate conversation on screen —
   * and under `pnpm dev`, where every edit to `server/` reattaches every
   * session, a fresh copy several times an hour.
   *
   * The window deliberately runs to the *end of `boot()`* rather than to the
   * load response. Nothing live can happen in the difference — the adapter has
   * no turn, Domo has not prompted, and `ensureStarted` is what a prompt waits
   * on — while ending it on the response would rest on the order in which the
   * SDK drains a notification it has already read against the response line
   * behind it, which is not something this file should have an opinion about.
   */
  private restoring = false
  private containerName: string | null = null
  private containerPidFile: string | null = null
  /** Everything the agent said this turn, which becomes the session summary. */
  private textBuffer = ''
  /** The block of streaming text currently being coalesced, if any. */
  private stream: StreamBlock | null = null
  /**
   * The status we last wrote. Deltas arrive many times a second and all of them
   * mean "thinking"; without this every one of them cost a session UPDATE (and
   * an Electric round trip) that changed nothing.
   */
  private status: AgentSessionStatus | null = null
  /** When `last_activity_at` was last written; see `ACTIVITY_TOUCH_MS`. */
  private touchedAt = 0
  /** The most recent context/cost reading, whether or not it has been written. */
  private usage: AgentUsage | null = null
  /** What the row already holds, so an unchanged reading writes nothing. */
  private writtenUsage: AgentUsage | null = null
  /** The trailing timer that will write `usage`; see `USAGE_WRITE_MS`. */
  private usageTimer: ReturnType<typeof setTimeout> | null = null
  /** The newest plan-limit reading a `usage_update` carried, still unwritten. */
  private planLimits: UsageLimitValue[] | null = null
  /** What was last written, so a repeated reading writes nothing. */
  private writtenPlanLimits: string | null = null
  /** The trailing timer that will write it; see `PLAN_LIMIT_WRITE_MS`. */
  private planLimitTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The `configOptions` entry the adapter last answered about its model,
   * cached from `session/new` / `session/load` and refreshed by `setModel`.
   * A live switch needs it to resolve a preference the way `applyRequestedModel`
   * does, without a second probe.
   */
  private modelOption: any = null
  /**
   * OpenCode exposes its agent/mode selector as a config option rather than
   * ACP's dedicated modes object. Null means the dedicated `set_mode` method.
   */
  private modeOption: any = null
  /**
   * The adapter's own settings as it last reported them, so a live change can
   * resolve a value without asking again. Kept beside the row's copy rather
   * than read back from it: the row is what the UI renders, this is what the
   * next `session/set_config_option` is checked against.
   */
  private configOptions: SessionConfigOptionInfo[] | null = null
  /**
   * The mode the adapter itself last reported being in — from `session/new` /
   * `session/load`, from a `current_mode_update` it sent, or from a
   * `session/set_mode` it accepted.
   *
   * Deliberately not read back off the row. The row says what was *asked for*,
   * so a session that drifted — an agent that switched mode by itself, an
   * adapter that came back on its own default — would agree with itself and
   * never be corrected, which is the one thing re-applying a mode exists to do.
   */
  private reportedModeId: string | null = null
  /**
   * The ACP SDK dispatches notifications without awaiting the previous handler,
   * so concurrent inserts would take `seq` values out of arrival order and
   * scramble streamed text. Every event write goes through this chain.
   */
  private writes: Promise<unknown> = Promise.resolve()
  /**
   * Serialises every decision that may start a turn — a delivery and a drain.
   *
   * Only the decision is held, never the turn itself: a critical section ends
   * as soon as `prompt` has claimed the turn slot. Without it, the drain a
   * finishing turn kicks off would race the `interrupt` that was waiting for
   * exactly that moment, and both would prompt into the same idle gap.
   */
  private deliveries: Promise<unknown> = Promise.resolve()

  constructor(agentSessionId: string) {
    this.agentSessionId = agentSessionId
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writes.then(fn, fn)
    this.writes = run.catch(() => {})
    return run
  }

  private serialDeliver<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.deliveries.then(fn, fn)
    this.deliveries = run.catch(() => {})
    return run
  }

  /**
   * Write the session status, but only when it actually changes. `touch` still
   * always writes: refreshing `last_activity_at` is the point of asking.
   */
  private async setStatus(
    status: AgentSessionStatus,
    patch: { touch?: boolean, lastError?: string | null, summary?: string } = {}
  ): Promise<void> {
    if (this.status === status && !patch.touch && patch.lastError === undefined && patch.summary === undefined) return
    this.status = status
    if (patch.touch) this.touchedAt = Date.now()
    await updateAgentSession(this.agentSessionId, { status, ...patch })
  }

  /**
   * Say the agent is still working, at most once every `ACTIVITY_TOUCH_MS`.
   *
   * Called from the flush timer and from the events that punctuate a turn, so
   * the write rate is bounded by the clock and never by the delta rate.
   */
  private async touchIfStale(): Promise<void> {
    if (Date.now() - this.touchedAt < ACTIVITY_TOUCH_MS) return
    this.touchedAt = Date.now()
    await updateAgentSession(this.agentSessionId, { touch: true })
  }

  /* ---------------- context and cost ---------------- */

  /**
   * Take in a `usage_update`.
   *
   * It is *state*, not transcript, which is the whole reason it is handled
   * before `takeStream()` in `onUpdate`: an open block of streaming text must
   * survive it untouched. Were it appended like any other update, it would
   * close the message the agent is halfway through writing and claim a `seq`
   * in the middle of it, so the text would come out split in two around a row
   * nothing renders.
   */
  private noteUsage(update: any): void {
    const next = normalizeAgentUsage(update, this.usage)
    if (next) {
      this.usage = next
      this.scheduleUsageWrite()
    }

    // A `rate_limit_event` rides in on one of these. It is the freshest reading
    // of the plan's limits there is — the poller's endpoint answers about once
    // an hour — so it goes to the account-wide table rather than to this row.
    // Held rather than written: it arrives on the same per-delta event as the
    // reading above and is throttled the same way.
    const rateLimit = update?._meta?.['_claude/rateLimit']
    if (rateLimit) {
      const limits = claudeSessionLimits(rateLimit)
      if (limits.length) {
        this.planLimits = limits
        this.schedulePlanLimitWrite()
      }
    }
  }

  /** Write the latest reading in a moment, if one is not already due. */
  private scheduleUsageWrite(): void {
    if (this.usageTimer) return
    const timer = setTimeout(() => {
      this.usageTimer = null
      void this.flushUsage()
    }, USAGE_WRITE_MS)
    timer.unref?.()
    this.usageTimer = timer
  }

  /**
   * Put the reading on the row, if it says anything new.
   *
   * Mirrors `setStatus`: remember what was last written, and skip the update
   * when it would change nothing. Called on every turn boundary and on close,
   * so the final number is never left sitting in a timer that gets cleared.
   *
   * The held plan limits settle with it. They ride in on the same event and
   * every boundary that wants the final context reading written wants the
   * final plan reading written too, so there is nothing to gain from a second
   * set of call sites that could drift out of step with this one.
   */
  private async flushUsage(): Promise<void> {
    await this.flushPlanLimits()
    if (this.usageTimer) {
      clearTimeout(this.usageTimer)
      this.usageTimer = null
    }
    const usage = this.usage
    if (!usage || sameAgentUsage(usage, this.writtenUsage)) return
    this.writtenUsage = usage
    try {
      await setAgentUsage(this.agentSessionId, usage)
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] could not record usage`, error)
    }
  }

  /** Write the held plan limits in a moment, if a write is not already due. */
  private schedulePlanLimitWrite(): void {
    if (this.planLimitTimer) return
    const timer = setTimeout(() => {
      this.planLimitTimer = null
      void this.flushPlanLimits()
    }, PLAN_LIMIT_WRITE_MS)
    timer.unref?.()
    this.planLimitTimer = timer
  }

  /**
   * Put the newest held reading on the account-wide table.
   *
   * Taking the reading is what makes a repeat cost nothing: only a
   * `usage_update` that arrived since the last write leaves anything here, so
   * a boundary flush with nothing new pending is a no-op without having to
   * compare values. `replace: false` because this names one or two windows and
   * knows nothing about the rest, so it must never remove a row a poll put
   * there.
   */
  private async flushPlanLimits(): Promise<void> {
    if (this.planLimitTimer) {
      clearTimeout(this.planLimitTimer)
      this.planLimitTimer = null
    }
    const limits = this.planLimits
    if (!limits) return
    this.planLimits = null
    // The same guard `writtenUsage` gives the reading above, and needed for
    // the same reason: the windows move on the scale of minutes, so most
    // readings in a turn repeat the last one exactly, and writing those would
    // re-stream an account-wide row to every browser to say nothing. Compared
    // as JSON because the array is small and built in a fixed order by
    // `claudeSessionLimits`, so there is nothing a field-by-field compare
    // would catch that this does not.
    const fingerprint = JSON.stringify(limits)
    if (fingerprint === this.writtenPlanLimits) return
    this.writtenPlanLimits = fingerprint
    try {
      await writeUsageLimits('claude', limits, { replace: false })
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] could not record plan limits`, error)
    }
  }

  /* ---------------- streaming text ---------------- */

  /**
   * Take the open block away from the runtime, synchronously, so that a delta
   * arriving right after cannot reopen or double-close it. The caller closes it
   * inside `serial`, which is what keeps `seq` in arrival order.
   */
  private takeStream(): StreamBlock | null {
    const block = this.stream
    this.stream = null
    if (block?.timer) {
      clearTimeout(block.timer)
      block.timer = null
    }
    return block
  }

  /**
   * Write a block's final text and drop its `streaming` flag. Runs in `serial`,
   * ahead of whatever event ended the block — which is why a failure here only
   * loses the text, and never the event that follows it.
   */
  private async closeStream(block: StreamBlock | null): Promise<void> {
    if (!block) return
    try {
      const row = await block.row
      await writeAgentStream(row.id, block.text, false)
      block.written = block.text
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] could not finish streamed text`, error)
    }
  }

  /** Fold a delta into the open block, opening one when the run starts. */
  private appendStream(type: AgentStreamType, text: string): void {
    const open = this.stream
    if (open && open.type === type) {
      open.text += text
      this.scheduleFlush(open)
      return
    }

    const previous = this.takeStream()
    const block: StreamBlock = { type, text, written: text, row: null!, timer: null }
    this.stream = block
    // One serial step: the previous block is finished before the next one takes
    // its `seq`, so two runs can never end up in the wrong order.
    block.row = this.serial(async () => {
      await this.closeStream(previous)
      return openAgentStream(this.agentSessionId, type, text)
    })
    block.row.catch(() => {})
  }

  private scheduleFlush(block: StreamBlock): void {
    if (block.timer) return
    const timer = setTimeout(() => {
      block.timer = null
      void this.flushStream(block)
    }, flushDelay(block.text.length))
    // A pending flush must not keep Node alive on its own.
    timer.unref?.()
    block.timer = timer
  }

  private async flushStream(block: StreamBlock): Promise<void> {
    if (block.written === block.text) return
    const text = block.text
    try {
      await this.serial(async () => {
        const row = await block.row
        await writeAgentStream(row.id, text, true)
        await this.touchIfStale()
      })
      block.written = text
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] could not flush streamed text`, error)
    }
  }

  get sessionId() {
    return this.acpSessionId
  }

  get alive() {
    return !!this.proc && !this.proc.killed
  }

  async ensureStarted(): Promise<void> {
    if (this.connection && this.acpSessionId && this.alive) return
    if (!this.booting) {
      this.booting = this.boot().catch(async (error) => {
        this.booting = null
        const message = error instanceof Error ? error.message : String(error)
        await this.setStatus('error', { lastError: message })
        await appendAgentEvent(this.agentSessionId, 'error', { message })
        throw error
      })
    }
    return this.booting
  }

  /**
   * The connection to ask, or `null` when there is none — and never a reason
   * to start one.
   *
   * Changing a setting is recording a *preference*, and the row is the
   * authority on what was asked for: `applySessionMode`, `applyRequestedModel`
   * and `applyAdapterConfig` re-apply all three from the row on every attach,
   * because `session/load` restores the adapter's defaults rather than Domo's
   * choices. So a stopped session told "use opus" comes up on opus the next
   * time somebody prompts it, and nothing has to run in the meantime. The
   * composer's pickers are always visible, so before this a click on a stopped
   * session spawned an adapter — inside a container, for an environment-backed
   * one — purely to write a column.
   *
   * A boot already in flight is waited for rather than raced: it applies the
   * row's settings partway through, so a write that landed after that read
   * would be invisible until the next attach. A boot that fails leaves the
   * caller on the offline path, which is exactly where a session that cannot
   * start should be changed from.
   */
  private async liveConnection(): Promise<acp.ClientConnection | null> {
    if (this.booting) await this.booting.catch(() => {})
    return this.connection && this.acpSessionId && this.alive ? this.connection : null
  }

  /**
   * The row still says `error`, but the adapter is up and nothing is running.
   *
   * That is the shape a *failed turn* leaves behind, and `ensureStarted` is a
   * no-op for it — so without this a retry on a session-limit error would
   * change nothing at all and the banner would stay put.
   */
  async clearStaleError(): Promise<void> {
    if (this.status !== 'error' || this.turn || !this.alive || !this.acpSessionId) return
    await this.setStatus('idle', { lastError: null, touch: true })
  }

  private async boot(): Promise<void> {
    const session = await getAgentSession(this.agentSessionId)
    if (!session) throw new Error(`Agent session ${this.agentSessionId} not found`)
    // Before anything is spawned, and before the row is touched. Every path
    // that can bring an adapter up — a prompt, a delivery, `start`, a mode or
    // model change, the mesh, cron — arrives at `ensureStarted` and therefore
    // here, so this is the one check that cannot be routed around. The nearer
    // guards below exist to give a better message, not to close a hole.
    assertSessionLive(session, 'starting its adapter')

    // Pick the row's reading back up, so a reattach neither rewrites the same
    // numbers nor loses the context window it already learned: mid-stream
    // updates carry the adapter's *guess* at the window until the first turn
    // result corrects it, and the row already holds the corrected one.
    this.usage = session.usage
    this.writtenUsage = session.usage

    await this.setStatus('starting', { lastError: null })

    let environment: DevEnvironment | null = null
    const env = await adapterEnv(session.adapter, !!session.devEnvironmentId)
    let proc: ChildProcessWithoutNullStreams
    if (session.devEnvironmentId) {
      environment = await ensureEnvironmentRunning(session.devEnvironmentId)
      this.containerName = environment.containerName
      this.containerPidFile = `/tmp/domo-agent-${this.agentSessionId}.pid`
      env.USER = environment.remoteUser ?? 'root'
      env.HOME = env.USER === 'root' ? '/root' : `/home/${env.USER}`
      env.LOGNAME = env.USER
      proc = spawn('docker', [
        ...containerExecArgs(environment, env),
        // The adapters live in the shared runtime volume at /opt/domo, not on the image's PATH.
        'sh', '-c', 'echo $$ > "$1"; exec "$2"', 'sh', this.containerPidFile, adapterCommandPath(session.adapter)
      ], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    } else {
      await mkdir(session.cwd, { recursive: true }).catch(() => {})
      const launch = adapterLaunch(session.adapter)
      proc = spawn(launch.command, launch.args, {
        cwd: session.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }) as ChildProcessWithoutNullStreams
    }
    this.proc = proc

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) console.error(`[acp:${this.agentSessionId}] ${text}`)
    })
    proc.on('exit', (code, signal) => {
      this.connection = null
      this.acpSessionId = null
      this.booting = null
      this.proc = null
      this.containerName = null
      this.containerPidFile = null
      for (const waiter of this.waiters.values()) waiter.resolve(null)
      this.waiters.clear()
      const block = this.takeStream()
      void this.serial(async () => {
        await this.closeStream(block)
        await this.flushUsage()
        await appendAgentEvent(this.agentSessionId, 'adapter-exit', { code, signal })
        // An adapter that could not start exits, so this handler and the boot
        // failure's own `setStatus('error')` race for the same row — and which
        // of the two lands last is not something the caller should have to
        // guess at. The error is the one that says *why*, and `lastError` beside
        // it is what the UI offers a retry on, so it wins either way.
        if (this.status !== 'error') await this.setStatus('stopped')
      }).catch(() => {})
    })

    const stream = acp.ndJsonStream(
      Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>
    )

    const connection = acp
      .client({ name: 'domo' })
      .onNotification(acp.methods.client.session.update, ctx => this.onUpdate(ctx.params))
      .onRequest(acp.methods.client.session.requestPermission, ctx => this.onPermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        const { path, line, limit } = ctx.params
        const content = environment
          ? await readEnvironmentFile(environment, path)
          : await readFile(path, 'utf8')
        if (line == null && limit == null) return { content }
        const lines = content.split('\n')
        const start = Math.max(0, (line ?? 1) - 1)
        const end = limit == null ? lines.length : start + limit
        return { content: lines.slice(start, end).join('\n') }
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        if (environment) {
          await writeEnvironmentFile(environment, ctx.params.path, ctx.params.content)
        } else {
          await mkdir(dirname(ctx.params.path), { recursive: true })
          await writeFile(ctx.params.path, ctx.params.content, 'utf8')
        }
        return {}
      })
      .connect(stream)
    this.connection = connection

    const initialized = (await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true }
      },
      clientInfo: { name: 'domo', title: 'Domo', version: '1.0.0' }
    } as any)) as any

    // Steering is an extension, so it is advertised in the response's top-level
    // `_meta` and not in `agentCapabilities`. Both installed adapters set it;
    // one that does not gets `interrupt` where it would have got `steer`.
    this.steering = initialized?._meta?.steering?.supported === true

    // The mesh is an HTTP MCP server now; an adapter that cannot speak that
    // transport gets no mesh rather than a server it would fail to connect to.
    const httpMcp = !!initialized?.agentCapabilities?.mcpCapabilities?.http
    if (!httpMcp) warnNoHttpMcp(session.adapter)

    const settings = await getSettings()
    const mcpServers = await this.mcpServersForSession(environment, httpMcp, settings)

    // Everything the adapter says from here until the end of this boot is
    // history, not news. See `restoring`.
    this.restoring = !!session.acpSessionId

    let sessionResponse: any = null
    if (session.acpSessionId) {
      try {
        sessionResponse = await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: session.acpSessionId,
          cwd: session.cwd,
          mcpServers
        } as any)
        this.acpSessionId = session.acpSessionId
      } catch (error) {
        console.error(`[acp:${this.agentSessionId}] load failed, starting fresh`, error)
      }
    }

    try {
      let fresh = false
      const patch: { acpSessionId?: string, modes?: any, modeId?: string } = {}
      if (!this.acpSessionId) {
        const created = (await connection.agent.request(acp.methods.agent.session.new, {
          cwd: session.cwd,
          mcpServers
        } as any)) as any
        sessionResponse = created
        fresh = true
        this.acpSessionId = created.sessionId
        patch.acpSessionId = created.sessionId
      }

      Object.assign(patch, await this.applySessionMode({ session, response: sessionResponse, settings, fresh }))
      // One write, not one per thing learned: `agent_sessions` is synced, so each
      // one re-streams the whole row to every browser.
      if (Object.keys(patch).length) await updateAgentSession(this.agentSessionId, patch)

      const described = await this.applyRequestedModel(session, sessionResponse, settings)
      await this.applyAdapterConfig(session, described, settings)
    } finally {
      // Before `setStatus('idle')` and before the drain below, so the first
      // turn this attach runs is recorded in full — and in a `finally`, because
      // a boot that throws past here (an unknown model, say) must not leave a
      // reattached session deaf for as long as the process lives.
      this.restoring = false
    }
    await this.setStatus('idle', { touch: true })

    // Queued messages outlive the process that queued them — that is the whole
    // point of owning the queue — so an attach is one of the two moments they
    // get delivered. It is a no-op when this boot is a `prompt` starting the
    // adapter, because that turn has already claimed the slot.
    this.drainInbox()
  }

  /**
   * Put the adapter in the mode the row asks for, and record which one it is in.
   *
   * `session/load` restores the *adapter's* transcript, not Domo's choices. It
   * comes back in whatever mode it defaults to — for Claude Code that means
   * asking for permissions again, however the session was set up — so the mode
   * has to be re-applied from the row on every attach, exactly as the model is
   * (`applyRequestedModel`). Under `pnpm dev` this is not a rare path: every
   * edit to `server/` restarts Nitro and reattaches every session.
   *
   * The row is the authority on what was *asked for* and the adapter on what
   * *is*, so what it answers with is what gets recorded. Returns the columns to
   * write rather than writing them, so a start is one row update.
   *
   * Nothing here appends a `mode_changed` event. That event means "somebody
   * changed the mode": the user or the voice agent through `setMode`, or the
   * agent itself through a `current_mode_update`, which is its own event. A
   * start is neither, and a line per restart would bury the turn it sits in.
   */
  private async applySessionMode(input: {
    session: AgentSession
    response: any
    settings: AppSettings
    /** A `session/new` response is authoritative about modes; a `session/load` may say nothing at all. */
    fresh: boolean
  }): Promise<{ modes?: any, modeId?: string }> {
    const { session, settings } = input
    const state = input.response?.modes ?? null
    this.modeOption = modeConfigOption(input.response)
    const hasReportedState = !!state || !!this.modeOption
    const available = hasReportedState ? availableModes(input.response) : null
    const reported = currentModeId(input.response)
    // The default is per adapter: the two share no mode ids at all.
    const fallback = settings.defaultAgentModes[session.adapter]
    const desired = session.modeId || fallback
    // A `session/load` may answer with no mode state even for an adapter that
    // has modes, so the row's own list is the other half of the question.
    const hasModes = hasReportedState || !!session.modes?.length
    let effective = reported ?? session.modeId ?? fallback
    // What the adapter says it is in, which is what a later `setMode` decides
    // against — never the row, or a drifted session could not be corrected.
    this.reportedModeId = reported

    if (desired && hasModes && desired !== reported) {
      try {
        effective = await this.requestMode(desired)
        this.reportedModeId = effective
      } catch (error) {
        // A mode that will not take is not a reason to fail the start: the
        // session still works, it just asks more often than it was told to.
        console.error(`[acp:${this.agentSessionId}] could not set mode ${desired}`, error)
      }
    }

    const patch: { modes?: any, modeId?: string } = {}
    if (available || input.fresh) patch.modes = available
    if (effective && effective !== session.modeId) patch.modeId = effective
    return patch
  }

  /**
   * Put the session on the model it asked for, and record which one it ended up
   * on either way.
   *
   * The model is per session — two agents may be on different ones at the same
   * time — so the row is what is consulted first, and `defaultModel` (the
   * adapter's own setting, then its environment pin) only answers for a row
   * that names none. Every adapter exposes the choice as an ACP
   * `configOptions` select in the category `model` and takes
   * `session/set_config_option`, so there is one mechanism rather than one per
   * adapter.
   *
   * What the adapter says it landed on is written back, so the row is a record
   * of the truth rather than of the request.
   *
   * A preference this adapter cannot honour never fails the start. It is
   * reported as an `error` event — in the transcript, where the user is
   * reading, naming which of the two sources to go and fix — and the row is
   * corrected to the model the adapter is really on, so nothing goes on
   * claiming a model the session is not running.
   *
   * This used to throw, on the reasoning that running on a model nobody asked
   * for is worse than not running. Two things took that apart. A model can now
   * be recorded with no adapter to check it against (`setModel`), so a typo
   * through the voice agent or the API would leave a session that could never
   * start again; and both remaining sources are visible and fixable in the UI,
   * where the environment pin this once protected was neither. A stale default
   * must not brick every new session on an adapter, and "silently" was the
   * load-bearing word in the old argument — an error in the transcript is not
   * silent.
   */
  private async applyRequestedModel(
    session: AgentSession,
    sessionResponse: any,
    settings: AppSettings
  ): Promise<any> {
    const option = modelConfigOption(sessionResponse)
    this.modelOption = option
    // The response that last described this session, which a model change
    // replaces: the adapter's other options are model-dependent (Claude Code
    // publishes no effort option at all on a model without effort levels), so
    // the config step has to read the newer answer, not this one.
    let latest = sessionResponse
    if (!option) return latest

    const preference = session.model || defaultModel(session.adapter, settings)
    let chosen = currentModel(option)

    if (preference) {
      const wanted = resolveModel(option, preference)
      if (!wanted) {
        // Said where the user is reading, and named by source so they know
        // which of the two to go and fix. `chosen` stays what the adapter
        // reports, so the row is corrected below rather than left claiming it.
        const from = session.model
          ? 'This session asked for'
          : `The default model for ${session.adapter} is`
        const message = `${from} "${preference}", which the adapter does not offer. `
          + `It offers: ${availableModelIds(option).join(', ') || '(none)'}. `
          + `The session is running on ${chosen?.value ?? 'the adapter’s default'} instead.`
        console.error(`[acp:${this.agentSessionId}] ${message}`)
        await appendAgentEvent(this.agentSessionId, 'error', { message })
      } else if (wanted.value !== chosen?.value) {
        const response = (await this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.acpSessionId,
          configId: wanted.configId,
          value: wanted.value
        } as any)) as any
        // The adapter answers with the full set of options; believe it about
        // what actually took, rather than what was asked for.
        this.modelOption = modelConfigOption(response) ?? this.modelOption
        chosen = currentModel(this.modelOption) ?? wanted
        latest = response
      } else {
        chosen = wanted
      }
    }

    if (chosen) {
      if (chosen.value !== session.model) {
        await updateAgentSession(this.agentSessionId, { model: chosen.value })
      }
      await appendAgentEvent(this.agentSessionId, 'model_changed', {
        modelId: chosen.value,
        name: chosen.name,
        requested: preference ?? null
      })
    }
    return latest
  }

  /**
   * Put the session on the adapter-specific settings it asked for, and record
   * what the adapter says it offers.
   *
   * This is the same shape as the mode and the model and for the same reason —
   * `session/load` restores the *adapter's* defaults, so a restart would
   * silently drop a reasoning effort the user chose an hour ago — but nothing
   * here knows what the settings *are*. Claude Code calls effort `effort` and
   * codex-acp calls it `reasoning_effort`; codex has a `collaboration_mode`
   * Claude does not; both hide options the current model cannot do. So the row
   * holds "what was asked for, by id" and this applies whichever of those the
   * adapter turns out to offer this time.
   *
   * An option that is *not* offered is skipped rather than failing the start:
   * an effort saved against Opus must not break a session the user has since
   * moved to a model with no effort levels. A value that is offered but wrong
   * is a different thing and does throw, because that one is a typo the user
   * can fix.
   */
  private async applyAdapterConfig(
    session: AgentSession,
    sessionResponse: any,
    settings: AppSettings
  ): Promise<void> {
    let reported = adapterConfigOptions(sessionResponse)
    this.configOptions = reported

    // The row wins over the install-wide default: one is this session's own
    // choice, the other is only what a session with no choice should start on.
    const desired: Record<string, string> = {
      ...(settings.defaultAgentConfig?.[session.adapter] ?? {}),
      ...(session.config ?? {})
    }

    const applied: Record<string, string> = {}
    for (const [key, value] of Object.entries(desired)) {
      const option = findConfigOption(reported, key)
      if (!option) continue
      const resolved = resolveConfigValue(option, value)
      if (!resolved) {
        console.warn(
          `[acp:${this.agentSessionId}] ${session.adapter} offers no "${option.name}" value matching `
          + `"${value}" (it offers: ${configValueIds(option).join(', ')}); leaving it alone.`
        )
        continue
      }
      applied[option.id] = resolved
      if (resolved === option.currentValue) continue
      try {
        const response = (await this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.acpSessionId,
          configId: option.id,
          value: resolved
        } as any)) as any
        // Every set answers with the whole list again, so one option's change
        // is also how the rest are refreshed.
        reported = adapterConfigOptions(response)
        this.configOptions = reported
      } catch (error) {
        // A setting that will not take is not a reason to fail the start: the
        // session still works, it just runs on the adapter's own default.
        console.error(`[acp:${this.agentSessionId}] could not set ${option.id}=${resolved}`, error)
      }
    }

    // One write, and only when something actually differs: `agent_sessions` is
    // synced, so an unchanged rewrite re-streams the row to every browser.
    const config = { ...(session.config ?? {}), ...applied }
    const patch: { config?: Record<string, string>, configOptions?: SessionConfigOptionInfo[] } = {}
    if (JSON.stringify(config) !== JSON.stringify(session.config ?? {})) patch.config = config
    if (!sameConfigOptions(reported, session.configOptions)) patch.configOptions = reported
    if (Object.keys(patch).length) await updateAgentSession(this.agentSessionId, patch)
  }

  private async mcpServersForSession(
    environment: DevEnvironment | null,
    httpMcp: boolean,
    settings: AppSettings
  ) {
    const servers = await listMcpServers()
    const out: any[] = []
    for (const server of servers) {
      if (!server.enabled) continue
      if (server.scope !== 'coding' && server.scope !== 'both') continue
      if (server.transport === 'stdio' && server.command) {
        out.push({
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
        })
      } else if (server.url) {
        out.push({
          name: server.name,
          type: server.transport,
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
        })
      }
    }
    // The headless browser, when this session has one. Environment-only, and
    // deliberately not a row in `mcp_servers`: every path in it names a volume
    // that is mounted into the container and exists nowhere on the host, while
    // a configured row is written once and handed to both.
    if (environment && settings.browserTools) out.push(browserMcpServer())

    // The agent-mesh server lets coding agents talk to each other and spawn
    // peers. One code path for host and container sessions: the container only
    // differs in which host name reaches Domo.
    if (httpMcp) {
      out.push({
        name: 'domo',
        type: 'http',
        url: `${internalBaseUrl(!!environment)}/api/internal/mcp`,
        headers: [{ name: 'Authorization', value: `Bearer ${mintMeshToken(this.agentSessionId)}` }]
      })
    }
    return out
  }

  /* ---------------- session updates ---------------- */

  private async onUpdate(params: any) {
    const update = params?.update
    if (!update) return
    const kind: string = update.sessionUpdate

    // The adapter is reading its own transcript back to us; see `restoring`.
    // Everything is dropped, the readings included: a `usage_update` from
    // before the restart describes a context window this connection does not
    // have, and `boot()` has already picked the row's own reading back up.
    if (this.restoring) return

    // Before `takeStream()` and before anything claims a `seq`: this is state,
    // it is not part of the transcript, and it arrives in the middle of the
    // message the agent is still writing.
    if (kind === 'usage_update') {
      this.noteUsage(update)
      return
    }

    const streamType: AgentStreamType | null
      = kind === 'agent_message_chunk'
        ? 'agent_message'
        : kind === 'agent_thought_chunk' ? 'agent_thought' : null

    if (streamType) {
      const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
      if (!text) return
      if (streamType === 'agent_message') this.textBuffer += text
      this.appendStream(streamType, text)
      await this.setStatus('thinking')
      return
    }

    // Detached here, before anything awaits: the block's row has to exist with a
    // lower `seq` than this event, or the transcript would show the text that
    // preceded a tool call after it.
    const block = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(block)
      await appendAgentEvent(this.agentSessionId, kind, update)
      if (kind === 'tool_call') await this.setStatus('thinking')
      // The agent may switch its own mode mid-turn, and the row is what gets
      // re-applied on the next attach — so it has to follow, not just the log.
      if (kind === 'current_mode_update' && update.currentModeId) {
        this.reportedModeId = update.currentModeId
        await updateAgentSession(this.agentSessionId, { modeId: update.currentModeId })
      }
      // A turn that is all tool calls and no text is still a working agent.
      await this.touchIfStale()
    })
  }

  private async onPermission(params: any): Promise<any> {
    const settings = await getSettings()
    const options = (params.options ?? []).map((option: any) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind
    }))
    const title: string = params.toolCall?.title || params.toolCall?.rawInput?.description || 'Tool call'

    const block = this.takeStream()
    const permission = await this.serial(async () => {
      await this.closeStream(block)
      const row = await createPermission({
        agentSessionId: this.agentSessionId,
        toolCallId: params.toolCall?.toolCallId ?? null,
        title,
        options,
        toolCall: params.toolCall ?? null
      })
      await appendAgentEvent(this.agentSessionId, 'permission_request', { permissionId: row.id, ...params })
      await this.setStatus('awaiting-permission', { touch: true })
      return row
    })

    if (settings.autoApprovePermissions) {
      const auto =
        options.find((o: any) => o.kind === 'allow_once') ?? options.find((o: any) => o.kind === 'allow_always')
      if (auto) {
        await resolvePermissionRow(permission.id, auto.optionId, 'auto')
        await this.setStatus('thinking')
        return { outcome: { outcome: 'selected', optionId: auto.optionId } }
      }
    }

    const optionId = await new Promise<string | null>((resolvePromise) => {
      this.waiters.set(permission.id, { permission, resolve: resolvePromise })
    })
    this.waiters.delete(permission.id)

    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    await this.setStatus('thinking')
    return { outcome: { outcome: 'selected', optionId } }
  }

  answerPermission(permissionId: string, optionId: string | null): boolean {
    const waiter = this.waiters.get(permissionId)
    if (!waiter) return false
    waiter.resolve(optionId)
    return true
  }

  hasPermission(permissionId: string) {
    return this.waiters.has(permissionId)
  }

  /* ---------------- turns ---------------- */

  get busy() {
    return !!this.turn
  }

  /**
   * Whether this connection advertised `_session/steering`. Worth asking before
   * choosing a delivery: `steer` on an adapter without it falls back to
   * `interrupt`, never to `queue`, which is right for "change course now" and
   * much too blunt for "here is something for later".
   */
  get steers() {
    return this.steering
  }

  /**
   * Start a turn now and see it through.
   *
   * Deliberately not `async`: the turn slot has to be claimed before the first
   * await, or a message arriving in that gap would read the session as idle and
   * send a second `session/prompt`. The adapter would accept it and queue it in
   * its own turn queue, where Domo cannot see it and a restart loses it — which
   * is exactly what the inbox exists to avoid. Everything that is not the
   * initial prompt of a session should go through `deliver`.
   */
  prompt(content: any[]): Promise<{ stopReason: string }> {
    const controller = new AbortController()
    let settle!: () => void
    const turn: Turn = {
      interrupted: false,
      cancel: () => controller.abort(),
      done: new Promise<void>((resolve) => { settle = resolve })
    }
    this.turn = turn

    return this.runTurn(content, turn, controller).finally(() => {
      if (this.turn === turn) this.turn = null
      settle()
      // A turn ending — normally, cancelled, or failed — is the other moment
      // the inbox drains.
      this.drainInbox()
    })
  }

  private async runTurn(
    content: any[],
    turn: Turn,
    controller: AbortController
  ): Promise<{ stopReason: string }> {
    assertSessionLive(await getAgentSession(this.agentSessionId), 'sending it a message')
    await this.ensureStarted()
    if (!this.connection || !this.acpSessionId) throw new Error('agent not started')

    this.textBuffer = ''
    const stale = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(stale)
      await appendAgentEvent(this.agentSessionId, 'user_message', { content })
      // `last_error` is history and the transcript already carries it at the
      // moment it happened; the row's copy describes the *current* state, so a
      // turn starting clears it. Left behind, a failed turn's message outlived
      // the failure and the banner kept describing it.
      await this.setStatus('thinking', { touch: true, lastError: null })
    })

    try {
      const response = (await this.connection.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId: this.acpSessionId, prompt: content } as any,
        { signal: controller.signal } as any
      )) as any
      // Queued behind any text writes still in flight, so the turn closes last.
      const block = this.takeStream()
      await this.serial(async () => {
        await this.closeStream(block)
        await appendAgentEvent(this.agentSessionId, 'turn_end', { stopReason: response?.stopReason, usage: response?.usage })
        await this.setStatus('idle', {
          touch: true,
          summary: this.textBuffer.trim().slice(-1200) || undefined
        })
        // The turn's final reading is the authoritative one — it is the result
        // that carries the real context window and the session's cost — so it
        // is written now rather than left in a timer a restart would drop.
        await this.flushUsage()
      })
      return { stopReason: response?.stopReason ?? 'end_turn' }
    } catch (error) {
      // An `interrupt` aborts this request on purpose and `cancel` has already
      // written the `cancelled` line; calling that an error would put the
      // session in `error` for doing what it was told.
      if (turn.interrupted) return { stopReason: 'cancelled' }
      const message = error instanceof Error ? error.message : String(error)
      const block = this.takeStream()
      await this.serial(async () => {
        await this.closeStream(block)
        await appendAgentEvent(this.agentSessionId, 'error', { message })
        await this.setStatus('error', { lastError: message, touch: true })
        await this.flushUsage()
      })
      throw error
    }
  }

  /* ---------------- delivery ---------------- */

  /**
   * Hand a message to the agent the way the sender asked for.
   *
   * With nothing running all three modes are the same thing — a prompt — so the
   * mode only ever decides what happens to a message that arrives mid-turn.
   */
  deliver(input: {
    content: any[]
    delivery: MessageDelivery
    origin: MessageOrigin
  }): Promise<DeliveryResult> {
    return this.serialDeliver(async () => {
      // Ahead of `ensureStarted` so the caller is told *why* rather than being
      // handed a boot failure, and ahead of every branch below so a retired
      // session cannot even be queued for — see `enqueueInboxMessage`, which
      // guards the one write that does not come through here.
      assertSessionLive(await getAgentSession(this.agentSessionId), 'sending it a message')
      await this.ensureStarted()

      if (!this.turn) {
        const turn = this.prompt(input.content)
        turn.catch(error => console.error(`[acp:${this.agentSessionId}] turn failed`, error))
        return { delivery: input.delivery, outcome: 'prompted' as const }
      }

      switch (input.delivery) {
        case 'queue':
          return this.enqueue(input.content, 'queue', input.origin)
        case 'interrupt':
          return this.interruptWith(input.content)
        default:
          return this.steerInto(input.content, input.origin)
      }
    })
  }

  private async enqueue(
    content: any[],
    delivery: MessageDelivery,
    origin: MessageOrigin
  ): Promise<DeliveryResult> {
    const row = await enqueueInboxMessage({
      agentSessionId: this.agentSessionId,
      content,
      delivery,
      origin
    })
    return { delivery, outcome: 'queued', inboxId: row.id }
  }

  /** Cancel what is running, wait for it to settle, then prompt. */
  private async interruptWith(content: any[]): Promise<DeliveryResult> {
    const running = this.turn
    if (running) {
      running.interrupted = true
      await this.cancel()
      await running.done
    }
    // The drain that turn kicked off is queued behind this critical section, so
    // it finds the slot taken and leaves the queue for the turn below.
    const turn = this.prompt(content)
    turn.catch(error => console.error(`[acp:${this.agentSessionId}] turn failed`, error))
    return { delivery: 'interrupt', outcome: 'prompted' }
  }

  /** Inject into the running turn, or fall back when the adapter cannot. */
  private async steerInto(content: any[], origin: MessageOrigin): Promise<DeliveryResult> {
    // "Change course now" is what was asked for, and queueing is the one thing
    // it definitely does not mean.
    if (!this.steering) return this.interruptWith(content)

    let outcome: string
    try {
      const response = (await this.connection!.agent.request(STEERING_METHOD, {
        sessionId: this.acpSessionId,
        prompt: content,
        _meta: STEERING_META
      } as any)) as any
      outcome = String(response?.outcome ?? 'failed')
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] steering failed, queueing instead`, error)
      return this.enqueue(content, 'steer', origin)
    }

    if (outcome === 'promptRequired' || outcome === 'failed') {
      // The turn settled inside the adapter between our check and the request.
      // Queue rather than prompt: our own `session/prompt` may still be in
      // flight, and its end is what drains the queue a moment later.
      return this.enqueue(content, 'steer', origin)
    }

    // The message joined the running turn, so the transcript has to show it in
    // its place — the agent is about to answer it.
    const block = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(block)
      await appendAgentEvent(this.agentSessionId, 'user_message', { content, delivery: 'steer' })
      await this.touchIfStale()
    })
    return { delivery: 'steer', outcome: 'steered' }
  }

  /**
   * Hand over everything that is waiting, if the agent is free to take it.
   *
   * One turn for the whole queue: two notes that arrived while the last turn
   * ran are one thing to answer, and a turn each meant the second one read the
   * first one's answer as context it never asked about. `combineInboxContent`
   * keeps them legible as separate messages.
   *
   * Fire-and-forget on purpose: the callers are a turn that has just ended and
   * an adapter that has just attached, and neither should wait on a whole turn.
   */
  drainInbox(): void {
    void this.serialDeliver(async () => {
      if (this.turn || !this.alive || !this.acpSessionId) return
      const waiting = await claimInboxMessages(this.agentSessionId)
      if (!waiting.length) return
      const turn = this.prompt(combineInboxContent(waiting))
      // Anything that arrives *during* this turn is drained when it ends.
      turn.catch(error => console.error(`[acp:${this.agentSessionId}] queued turn failed`, error))
    }).catch(error => console.error(`[acp:${this.agentSessionId}] could not drain the inbox`, error))
  }

  async cancel(): Promise<void> {
    if (!this.connection || !this.acpSessionId) return
    await this.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: this.acpSessionId
    } as any)
    for (const waiter of this.waiters.values()) waiter.resolve(null)
    this.waiters.clear()
    this.turn?.cancel()
    const block = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(block)
      await appendAgentEvent(this.agentSessionId, 'cancelled', {})
      await this.setStatus('idle', { touch: true })
    })
  }

  /**
   * Put the session in a permission mode — in the adapter if one is running,
   * on the row either way.
   *
   * Nothing is spawned: see `liveConnection`. With no adapter to ask, the id
   * is still checked against the modes that adapter last reported, so a
   * mistyped mode is refused at the moment somebody chooses it rather than at
   * the next start, on a session that has run at least once. A session that
   * never has knows no modes and takes what it is given; the next attach
   * applies it and keeps whatever the adapter answers with.
   *
   * The request is skipped when the adapter already reports this mode — and
   * `reportedModeId` is the adapter's own word for that, never the row's.
   */
  async setMode(modeId: string): Promise<void> {
    const connection = await this.liveConnection()
    const session = await getAgentSession(this.agentSessionId)
    // The boot path used to be the only way in here, and it is where the
    // retirement guard sits. These three no longer start an adapter — that is
    // the point of `liveConnection()` — so a retired session would otherwise
    // take the offline branch and quietly write the row.
    assertSessionLive(session, 'changing its settings')

    let effective = modeId
    if (connection) {
      if (this.reportedModeId !== modeId) {
        effective = await this.requestMode(modeId)
        this.reportedModeId = effective
      } else if (session?.modeId === modeId) {
        // The adapter is in it and the row says so: nothing changed, and a
        // "Mode set to …" line for a change nobody made is noise.
        return
      }
    } else {
      const known = session?.modes ?? []
      if (known.length && !known.some(mode => mode.id === modeId)) {
        throw new Error(
          `This session's adapter does not offer the mode "${modeId}". `
          + `It offers: ${known.map(mode => mode.id).join(', ')}.`
        )
      }
      if (session?.modeId === modeId) return
    }

    await updateAgentSession(this.agentSessionId, { modeId: effective })
    await appendAgentEvent(this.agentSessionId, 'mode_changed', {
      modeId: effective,
      ...pendingMark(!!connection)
    })
  }

  /**
   * Ask the adapter for a mode, whichever way this one publishes them, and
   * answer with what it says it is in now.
   *
   * Two wire representations, one concept: most adapters take ACP's own
   * `session/set_mode` against the `modes` object, while OpenCode publishes
   * the choice as a `mode` config option and takes
   * `session/set_config_option`. `modeOption` is which of the two this session
   * is, learned from the last `session/new` / `session/load`, and it is
   * refreshed here because a set answers with the whole option again.
   */
  private async requestMode(modeId: string): Promise<string> {
    if (this.modeOption) {
      const response = (await this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.acpSessionId,
        configId: this.modeOption.id,
        value: modeId
      } as any)) as any
      this.modeOption = modeConfigOption(response) ?? this.modeOption
      return currentModeId(response) ?? modeId
    }
    await this.connection!.agent.request(acp.methods.agent.session.setMode, {
      sessionId: this.acpSessionId,
      modeId
    } as any)
    return modeId
  }

  /**
   * Put the session on a different model — in the adapter if one is running,
   * on the row either way.
   *
   * The same "ask the adapter, believe what it answers" shape as `setMode`,
   * through `session/set_config_option` because that is how a model choice
   * rides in ACP — there is no dedicated method for it. `resolveModel` against
   * the cached `modelOption` is what lets a caller write "opus" or "haiku"
   * rather than the adapter's own id, exactly as a freshly-booted session does
   * in `applyRequestedModel`.
   *
   * With no adapter running there is nothing to resolve against — a model list
   * exists only in a `session/new` answer, and probing for one is the spawn
   * this is here to avoid — so the row keeps the preference *verbatim* and
   * `applyRequestedModel` resolves it, fuzzily and against the real list, at
   * the next attach. That is the one asymmetry of the offline path: the row
   * then holds what was asked for rather than what the adapter landed on. It
   * is corrected on that attach, including when the answer is that no such
   * model exists.
   */
  async setModel(model: string): Promise<void> {
    const connection = await this.liveConnection()
    const session = await getAgentSession(this.agentSessionId)
    // The boot path used to be the only way in here, and it is where the
    // retirement guard sits. These three no longer start an adapter — that is
    // the point of `liveConnection()` — so a retired session would otherwise
    // take the offline branch and quietly write the row.
    assertSessionLive(session, 'changing its settings')

    if (!connection) {
      const requested = model.trim()
      if (!requested) throw new Error('No model was given.')
      if (session?.model === requested) return
      await updateAgentSession(this.agentSessionId, { model: requested })
      await appendAgentEvent(this.agentSessionId, 'model_changed', {
        modelId: requested,
        name: requested,
        requested,
        ...pendingMark(false)
      })
      return
    }

    const wanted = resolveModel(this.modelOption, model)
    if (!wanted) {
      throw new Error(
        `This session's adapter does not offer a model matching "${model}". `
        + `It offers: ${availableModelIds(this.modelOption).join(', ') || '(none)'}.`
      )
    }

    let chosen = wanted
    if (currentModel(this.modelOption)?.value !== wanted.value) {
      const response = (await connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.acpSessionId,
        configId: wanted.configId,
        value: wanted.value
      } as any)) as any
      this.modelOption = modelConfigOption(response) ?? this.modelOption
      chosen = currentModel(this.modelOption) ?? wanted
      // A model change rewrites the rest of the adapter's settings: Claude Code
      // offers no effort at all on a model without effort levels, and the levels
      // themselves differ between models. The picker has to follow, so the fresh
      // list goes back on the row with the model that caused it.
      this.configOptions = adapterConfigOptions(response)
      await updateAgentSession(this.agentSessionId, {
        model: chosen.value,
        configOptions: this.configOptions
      })
    } else {
      // Already on it, so nothing is asked and nothing is refreshed — the
      // options under a model that did not change did not change either. The
      // row may still be behind it (a drift the last attach corrected), and
      // that much is worth writing.
      if (session?.model === chosen.value) return
      await updateAgentSession(this.agentSessionId, { model: chosen.value })
    }

    await appendAgentEvent(this.agentSessionId, 'model_changed', {
      modelId: chosen.value,
      name: chosen.name,
      requested: model
    })
  }

  /**
   * Change one of the adapter's own settings — in the adapter if one is
   * running, on the row either way.
   *
   * `configId` is matched loosely (`findConfigOption`) so "reasoning effort"
   * reaches `effort` on Claude Code and `reasoning_effort` on Codex — the two
   * adapters do not share the id, and a caller should not have to care which
   * one it is talking to. What the adapter answers with is what gets recorded,
   * and the request is remembered in `config` so the next attach re-applies it.
   *
   * This is the one setting a stopped session can still check properly: the
   * row carries the list the adapter last reported (`configOptions`), which is
   * also the list the composer renders its pickers from, so both the id and
   * the value are resolved against exactly what the user was offered. What is
   * *not* written offline is `configOptions` itself — that column is the
   * adapter's own report, and a value nobody has confirmed does not belong in
   * it.
   */
  async setConfigOption(configId: string, value: string): Promise<void> {
    const connection = await this.liveConnection()
    const session = await getAgentSession(this.agentSessionId)
    // The boot path used to be the only way in here, and it is where the
    // retirement guard sits. These three no longer start an adapter — that is
    // the point of `liveConnection()` — so a retired session would otherwise
    // take the offline branch and quietly write the row.
    assertSessionLive(session, 'changing its settings')

    // The adapter's own word while it is up; the row's copy of its last word
    // when it is not. Never the row while a connection exists — a session that
    // drifted would agree with itself and never be corrected.
    const offered = connection ? this.configOptions : (session?.configOptions ?? null)
    const option = findConfigOption(offered, configId)
    if (!option) {
      const known = (offered ?? []).map(entry => entry.id).join(', ')
      throw new Error(
        `This session has no setting matching "${configId}". It offers: ${known || '(none)'}.`
      )
    }
    const resolved = resolveConfigValue(option, value)
    if (!resolved) {
      throw new Error(
        `"${option.name}" does not offer a value matching "${value}". `
        + `It offers: ${configValueIds(option).join(', ')}.`
      )
    }

    if (connection && option.currentValue !== resolved) {
      const response = (await connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.acpSessionId,
        configId: option.id,
        value: resolved
      } as any)) as any
      this.configOptions = adapterConfigOptions(response)
      await updateAgentSession(this.agentSessionId, {
        config: { ...(session?.config ?? {}), [option.id]: resolved },
        configOptions: this.configOptions
      })
    } else {
      // Either there is no adapter, or it is already on this value. Both leave
      // the row's `config` as the only thing to write — and it is still worth
      // writing when the adapter is already there, because that column is what
      // pins the choice through the next `session/load`.
      if (session?.config?.[option.id] === resolved) return
      await updateAgentSession(this.agentSessionId, {
        config: { ...(session?.config ?? {}), [option.id]: resolved }
      })
    }

    await appendAgentEvent(this.agentSessionId, 'config_changed', {
      configId: option.id,
      name: option.name,
      value: resolved,
      requested: value,
      ...pendingMark(!!connection)
    })
  }

  stop(): void {
    // A block left open would render as text that streams forever, and a
    // reading left in the trailing timer would be lost with the process.
    const block = this.takeStream()
    void this.serial(async () => {
      await this.closeStream(block)
      await this.flushUsage()
    }).catch(() => {})
    for (const waiter of this.waiters.values()) waiter.resolve(null)
    this.waiters.clear()
    this.connection?.close()
    this.connection = null
    if (this.containerName && this.containerPidFile) {
      const killer = spawn('docker', [
        'exec', this.containerName,
        'sh', '-c', 'test ! -f "$1" || kill "$(cat "$1")"; rm -f "$1"',
        'sh', this.containerPidFile
      ], { stdio: 'ignore' })
      killer.unref()
    }
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.acpSessionId = null
    this.booting = null
    this.containerName = null
    this.containerPidFile = null
  }
}

/* ------------------------------------------------------------------ */
/* manager                                                             */
/* ------------------------------------------------------------------ */

const warnedNoHttpMcp = new Set<AgentAdapter>()

/** Said once per adapter: a storm of this would drown the adapter's own output. */
function warnNoHttpMcp(adapter: AgentAdapter): void {
  if (warnedNoHttpMcp.has(adapter)) return
  warnedNoHttpMcp.add(adapter)
  console.warn(
    `[acp] the ${adapter} adapter does not advertise HTTP MCP support `
    + '(agentCapabilities.mcpCapabilities.http), so its sessions get no agent mesh: '
    + 'they cannot list, message or spawn peers, or page the voice supervisor. '
    + 'Upgrade the adapter to restore it.'
  )
}

class AcpManager {
  private runtimes = new Map<string, AgentRuntime>()

  private runtime(agentSessionId: string): AgentRuntime {
    let runtime = this.runtimes.get(agentSessionId)
    if (!runtime) {
      runtime = new AgentRuntime(agentSessionId)
      this.runtimes.set(agentSessionId, runtime)
    }
    return runtime
  }

  async create(input: {
    adapter?: AgentAdapter
    title?: string
    cwd?: string
    voiceSessionId?: string | null
    modeId?: string | null
    /** Model id for *this* session; omitted means the install default, then the adapter's. */
    model?: string | null
    devEnvironmentId?: string | null
    initialPrompt?: string
  }): Promise<AgentSession> {
    const settings = await getSettings()
    const environment = input.devEnvironmentId
      ? await ensureEnvironmentRunning(input.devEnvironmentId)
      : null
    const cwd = environment?.workspacePath ?? normalizeCwd(input.cwd || settings.defaultCwd)
    const title = (input.title || input.initialPrompt || 'Coding session').trim().split('\n')[0]!.slice(0, 80)
    const session = await createAgentSession({
      adapter: input.adapter ?? 'claude-code',
      title,
      cwd,
      voiceSessionId: input.voiceSessionId ?? null,
      modeId: input.modeId ?? settings.defaultAgentModes[input.adapter ?? 'claude-code'],
      model: input.model?.trim() || null,
      devEnvironmentId: environment?.id ?? null
    })
    // A failed boot is recorded on the session row (status + lastError) so the
    // UI can show it and offer a retry instead of blowing up the request.
    const started = await this.runtime(session.id)
      .ensureStarted()
      .then(() => true)
      .catch(() => false)

    if (started && input.initialPrompt) {
      void this.promptInBackground(session.id, [{ type: 'text', text: input.initialPrompt }])
    }
    return (await getAgentSession(session.id))!
  }

  async start(agentSessionId: string): Promise<void> {
    const runtime = this.runtime(agentSessionId)
    await runtime.ensureStarted()
    // A failed boot clears the error in `boot()`; a failed turn leaves a live
    // adapter, which `ensureStarted` has nothing to do about.
    await runtime.clearStaleError()
  }

  /** Fire-and-forget turn: the UI and the voice agent follow it through events. */
  async promptInBackground(agentSessionId: string, content: any[]): Promise<void> {
    const runtime = this.runtime(agentSessionId)
    try {
      await runtime.prompt(content)
    } catch (error) {
      console.error(`[acp:${agentSessionId}] turn failed`, error)
    }
  }

  async prompt(agentSessionId: string, content: any[]) {
    return this.runtime(agentSessionId).prompt(content)
  }

  /**
   * Send a message to an agent that may already be working.
   *
   * Every way of reaching a coding agent — the prompt endpoint, the voice tool,
   * the mesh tool, a subscription note — comes through here, so "what happens
   * to a message that arrives mid-turn" is decided in one place.
   */
  async deliver(
    agentSessionId: string,
    input: { content: any[], delivery?: MessageDelivery, origin?: MessageOrigin }
  ): Promise<DeliveryResult> {
    return this.runtime(agentSessionId).deliver({
      content: input.content,
      delivery: input.delivery ?? 'steer',
      origin: input.origin ?? 'user'
    })
  }

  /** Hand over anything waiting, if the agent is free to take it. */
  drainInbox(agentSessionId: string): void {
    this.runtimes.get(agentSessionId)?.drainInbox()
  }

  isBusy(agentSessionId: string) {
    return this.runtimes.get(agentSessionId)?.busy ?? false
  }

  /**
   * Whether this session's adapter advertised steering. False for a session
   * with no live connection, which is the honest answer — nothing has said yet.
   */
  supportsSteering(agentSessionId: string) {
    return this.runtimes.get(agentSessionId)?.steers ?? false
  }

  async cancel(agentSessionId: string) {
    await this.runtime(agentSessionId).cancel()
  }

  async setMode(agentSessionId: string, modeId: string) {
    await this.runtime(agentSessionId).setMode(modeId)
  }

  async setModel(agentSessionId: string, model: string) {
    await this.runtime(agentSessionId).setModel(model)
  }

  async setConfigOption(agentSessionId: string, configId: string, value: string) {
    await this.runtime(agentSessionId).setConfigOption(configId, value)
  }

  async answerPermission(
    agentSessionId: string,
    permissionId: string,
    optionId: string | null,
    by: PendingPermission['resolvedBy']
  ): Promise<boolean> {
    const runtime = this.runtimes.get(agentSessionId)
    const answered = runtime?.answerPermission(permissionId, optionId) ?? false
    await resolvePermissionRow(permissionId, optionId, by)
    return answered
  }

  stop(agentSessionId: string) {
    this.runtimes.get(agentSessionId)?.stop()
    this.runtimes.delete(agentSessionId)
  }

  isRunning(agentSessionId: string) {
    return this.runtimes.get(agentSessionId)?.alive ?? false
  }

  async shutdown() {
    for (const id of [...this.runtimes.keys()]) this.stop(id)
    const sessions = await listAgentSessions()
    for (const session of sessions) {
      if (session.status !== 'stopped') {
        await updateAgentSession(session.id, { status: 'stopped' }).catch(() => {})
      }
    }
  }
}

export { normalizeCwd }

const globalKey = '__domo_acp_manager__'
const g = globalThis as any
export const acpManager: AcpManager = g[globalKey] ?? (g[globalKey] = new AcpManager())

// Keep the UI honest about stale statuses after a dev-server reload.
bus.setMaxListeners(0)
