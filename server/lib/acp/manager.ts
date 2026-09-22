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
import { internalBaseUrl } from '../internal-url'
import { mintMeshToken } from '../mesh/token'
import { normalizeCwd } from '../paths'
import { getSettings } from '../settings'
import { adapterEntry, adapterEnv } from './adapter-process'
import { claudeSessionLimits, normalizeAgentUsage, sameAgentUsage } from '../usage/normalize'
import { combineInboxContent } from './inbox'
import { availableModelIds, currentModel, modelConfigOption, pinnedModel, resolveModel } from './model'
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
  PendingPermission
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
    const rateLimit = update?._meta?.['_claude/rateLimit']
    if (rateLimit) {
      const limits = claudeSessionLimits(rateLimit)
      // `replace: false`: this names one or two windows and knows nothing about
      // the rest, so it must never remove a row a poll put there.
      if (limits.length) {
        void writeUsageLimits('claude', limits, { replace: false })
          .catch(error => console.error(`[acp:${this.agentSessionId}] could not record plan limits`, error))
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
   */
  private async flushUsage(): Promise<void> {
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
      proc = spawn(process.execPath, [adapterEntry(session.adapter)], {
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

    const mcpServers = await this.mcpServersForSession(environment, httpMcp)
    const settings = await getSettings()

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

    await this.applyRequestedModel(session, sessionResponse)
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
    const available = state
      ? (state.availableModes ?? []).map((mode: any) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? null
        }))
      : null
    const reported: string | null = state?.currentModeId ?? null
    // The default is per adapter: the two share no mode ids at all.
    const fallback = settings.defaultAgentModes[session.adapter]
    const desired = session.modeId || fallback
    // A `session/load` may answer with no mode state even for an adapter that
    // has modes, so the row's own list is the other half of the question.
    const hasModes = !!state || !!session.modes?.length
    let effective = reported ?? session.modeId ?? fallback

    if (desired && hasModes && desired !== reported) {
      try {
        await this.connection!.agent.request(acp.methods.agent.session.setMode, {
          sessionId: this.acpSessionId,
          modeId: desired
        } as any)
        effective = desired
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
   * time — so the row is what is consulted; `NUXT_CLAUDE_MODEL` /
   * `NUXT_CODEX_MODEL` are only the install-wide default for a row that names
   * none. Both adapters expose the choice as an ACP `configOptions` select in
   * the category `model` and take `session/set_config_option`, so there is one
   * mechanism rather than one per adapter.
   *
   * What the adapter says it landed on is written back, so the row is a record
   * of the truth rather than of the request.
   */
  private async applyRequestedModel(session: AgentSession, sessionResponse: any): Promise<void> {
    const option = modelConfigOption(sessionResponse)
    if (!option) return

    const preference = session.model || pinnedModel(session.adapter)
    let chosen = currentModel(option)

    if (preference) {
      const wanted = resolveModel(option, preference)
      if (!wanted) {
        throw new Error(
          `The ${session.adapter} adapter does not offer a model matching "${preference}". `
          + `It offers: ${availableModelIds(option).join(', ') || '(none)'}.`
        )
      }
      if (wanted.value !== chosen?.value) {
        const response = (await this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId: this.acpSessionId,
          configId: wanted.configId,
          value: wanted.value
        } as any)) as any
        // The adapter answers with the full set of options; believe it about
        // what actually took, rather than what was asked for.
        chosen = currentModel(modelConfigOption(response)) ?? wanted
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
  }

  private async mcpServersForSession(environment: DevEnvironment | null, httpMcp: boolean) {
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

  async setMode(modeId: string): Promise<void> {
    await this.ensureStarted()
    if (!this.connection || !this.acpSessionId) return
    await this.connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: this.acpSessionId,
      modeId
    } as any)
    await updateAgentSession(this.agentSessionId, { modeId })
    await appendAgentEvent(this.agentSessionId, 'mode_changed', { modeId })
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

  async cancel(agentSessionId: string) {
    await this.runtime(agentSessionId).cancel()
  }

  async setMode(agentSessionId: string, modeId: string) {
    await this.runtime(agentSessionId).setMode(modeId)
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
