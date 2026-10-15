import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname } from 'node:path'
import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

import { bus } from '../bus'
import { adapterCommandPath } from '../dev-env/runtime-volume'
import {
  assertNotRetired,
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
import { assertSessionStartable } from './startable'
import { claudeSessionLimits, normalizeAgentUsage, sameAgentUsage, type UsageLimitValue } from '../usage/normalize'
import { combineInboxContent } from './inbox'
import { assistantSystemPrompt, currentSessionFor, primeFirstPrompt } from '../assistants/context'
import {
  adapterConfigOptions,
  configValueIds,
  findConfigOption,
  resolveConfigValue,
  sameConfigOptions
} from './config-options'
import {
  ambiguousModelMatches,
  availableModelIds,
  currentModel,
  defaultModel,
  modelConfigOption,
  resolveModel
} from './model'
import { availableModes, currentModeId, modeConfigOption } from './mode'
import { nameSessionInBackground } from './session-title'
import {
  appendAgentEvent,
  claimInboxMessages,
  createAgentSession,
  createPermission,
  enqueueInboxMessage,
  getAgentSession,
  getAgentSessionWithEnvironment,
  getDevEnvironment,
  listAgentSessions,
  listInboxMessages,
  listMcpServers,
  listSessionsWithPendingInbox,
  releaseInboxMessages,
  openAgentStream,
  resolvePermissionRow,
  setAgentUsage,
  titleUntitledAgentSession,
  UNTITLED_AGENT_TITLE,
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
  QueuedDeliveryResult,
  SessionConfigOptionInfo,
  SessionModeInfo
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

/**
 * The statuses that claim a session is mid-something, and so are the ones a
 * live adapter with no turn and no waiter can disprove. See `reconcileStatus`.
 */
const BUSY_STATUSES = new Set<AgentSessionStatus>(['starting', 'thinking', 'awaiting-permission', 'error'])

/**
 * The `session/update` kinds that are *about* a session rather than work done
 * in it, and so must never be read as a turn beginning.
 *
 * A deny-list and not an allow-list on purpose: a kind wrongly counted as work
 * costs a spurious turn — a "started on its own" line in the transcript, a
 * minute at `thinking`, a note to every subscriber — while a kind wrongly left
 * out reproduces the bug this exists to fix: a session stuck at `thinking` with
 * its inbox stranded. Of the two, only the second is silent.
 *
 * Every entry here is one that arrives with no turn running in normal use.
 * `session_info_update` is claude-agent-acp's generated title, which it asks
 * the CLI for *after* a turn ends, in the background, and publishes a couple of
 * seconds later — after Domo has already closed the turn. codex-acp's thread
 * status rides on the same kind and is read before this list; see
 * `codexThreadStatus`.
 * `available_commands_update` is sent from a `setTimeout(…, 0)` scheduled
 * inside `loadSession`, so it lands after the load response and can outrun the
 * end of `boot()` — after `restoring` has been cleared, on a session that is
 * only attaching.
 */
const SESSION_STATE_UPDATES = new Set([
  'usage_update',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update'
])

/**
 * Who started the turn in flight, which is the whole of the difference between
 * the two.
 *
 * A `domo` turn is a `session/prompt` this process is waiting on, so its end is
 * a promise resolving and its `stopReason` comes off the wire. An `adapter` one
 * is a turn the agent started by itself — it schedules itself to wake up later,
 * it is re-invoked when a background task it launched finishes, it watches for
 * something and resumes when it changes — and there is no request outstanding
 * to answer, so nothing on the wire ever says it ended. See `openAdapterTurn`.
 */
type TurnOrigin = 'domo' | 'adapter'

/** A turn in flight, whoever started it. */
interface Turn {
  origin: TurnOrigin
  cancel: () => void
  /** Resolves once the turn has settled, however it settled. */
  done: Promise<void>
  /** Set by an `interrupt` delivery: the abort is deliberate, not a failure. */
  interrupted: boolean
  /**
   * The adapter has finished and only Domo's own bookkeeping is left.
   *
   * `this.turn` is cleared in `prompt`'s `finally`, which runs after `runTurn`
   * has written `turn_end`, flushed the usage and set the status — several
   * round trips *after* the adapter answered. For that whole window the slot
   * still says "a turn is running" while the adapter is idle, and a `steer`
   * landing in it is sent to an adapter with nothing to steer. claude-agent-acp
   * answers `promptRequired` and hands it back; codex-acp ignores the opt-in
   * and starts a detached turn — the exact thing this file exists to stop. So the flag is raised the instant the request answers, and a delivery
   * that sees it queues instead: the drain right behind it is what sends it.
   */
  settled: boolean
  /** The agent launched a subagent in the background during this Domo turn. */
  backgroundAgents?: boolean
  /** End a Domo turn without waiting for its `session/prompt`; see `noteResult`. */
  release?: () => void
}

/**
 * The `_claude/origin` kinds of a result Claude Code produced on its own rather
 * than for the prompt in flight — a background task reporting back, above all.
 * claude-agent-acp keeps the same list as `AUTONOMOUS_RESULT_ORIGINS`.
 */
const AUTONOMOUS_ORIGINS = new Set(['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity'])

/**
 * The tool call a Claude Code subagent's update belongs to, or null when the
 * session's own agent sent it.
 *
 * claude-agent-acp forwards a subagent's work on the parent's session, stamped
 * with the id of the `Agent` call that spawned it. A background subagent keeps
 * sending after the parent has finished writing, so read as the parent's own,
 * its tool calls cut the parent's message into pieces and held the session at
 * `thinking` after its turn was over.
 */
function subagentParent(update: any): string | null {
  const id = update?._meta?.claudeCode?.parentToolUseId
  return typeof id === 'string' && id ? id : null
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
 * It is not decoration: the sidebar and `list_agents` order sessions by it.
 * Left to status transitions alone, an agent streaming for twenty minutes
 * would look like the stalest one in the list.
 */
const ACTIVITY_TOUCH_MS = 30_000

/**
 * What codex-acp says about whether its thread is running a turn, or null for
 * an update that says nothing about it.
 *
 * This is the only end signal an unprompted turn has on ACP v1, which ends a
 * turn by answering its `session/prompt`, and nobody sent one. codex-acp
 * forwards Codex's `thread/status/changed` as a `session_info_update` with
 * `_meta.codex.threadStatus`, prompt or not. Anything but `active` (`idle`,
 * `systemError`, `notLoaded`) means the thread has no turn running.
 *
 * claude-agent-acp has no equivalent on v1. Its `usage_update` with a `cost`
 * marks a Claude Code `result`, but a queued background-task notification gets
 * a placeholder result *before* the follow-up it belongs to runs, and the
 * placeholder looks the same on the wire. Its real signal, a `state_update`
 * that goes `idle`, exists only on its experimental ACP v2 surface. OpenCode
 * sends nothing of the kind.
 */
export function codexThreadStatus(update: any): 'active' | 'idle' | null {
  if (update?.sessionUpdate !== 'session_info_update') return null
  const type = update._meta?.codex?.threadStatus?.type
  if (typeof type !== 'string') return null
  return type === 'active' ? 'active' : 'idle'
}

/**
 * How long a turn nobody prompted may say nothing before Domo calls it over,
 * when nothing the adapter said holds it open.
 *
 * The error to design against is ending *early*. A turn declared over while
 * the adapter is still in one drains the inbox into it, and the
 * `session/prompt` sent then lands in the adapter's own queue, which Domo
 * cannot see. Ending late only leaves the badge at `thinking` for longer. So a
 * minute, which covers a model round trip on a full context.
 *
 * Two things hold the turn open with no deadline at all: a tool call the turn
 * opened that has not reported `completed` or `failed`, and a Codex thread
 * that says it is `active`. Both are the adapter's own word that it is still
 * working, and a command may run for an hour. A turn held that way still ends
 * when the adapter exits, on a cancel, on a reattach and on a server restart.
 */
const ADAPTER_TURN_IDLE_MS = 60_000

/**
 * The window above, where a test can shorten it. A test fakes no clock here,
 * because faked timers deadlock the `pg` pool this runtime writes through.
 * Nothing in the app writes to it.
 */
export const adapterTurnWindows = {
  idle: ADAPTER_TURN_IDLE_MS
}

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

/** A mode's name for its `mode_changed` event, when the session knows it. */
function modeName(modes: SessionModeInfo[] | null | undefined, modeId: string): { name?: string } {
  const name = modes?.find(mode => mode.id === modeId)?.name
  return name ? { name } : {}
}

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
/** A session title out of the words that started it: the first line, clipped. */
function titleFrom(text: string): string {
  return text.trim().split('\n')[0]!.slice(0, 80)
}

/**
 * Whether a permission request is for the domo mesh's `hand_off` tool. Claude
 * Code names it `mcp__domo__hand_off`; other harnesses name MCP tools their
 * own way, so the server and the tool are matched loosely in the title.
 */
export function isDomoHandOff(toolCall: any): boolean {
  const name = String(toolCall?._meta?.claudeCode?.toolName ?? toolCall?.name ?? toolCall?.title ?? '')
  return /domo/i.test(name) && /hand_off$/.test(name)
}

function pendingMark(live: boolean): { pending?: true } {
  return live ? {} : { pending: true }
}

/**
 * Who a prompt came from, on its `user_message`: the transcript draws a
 * message from another agent or from Domo differently from one the person
 * typed. Absent when a turn hands over several queued messages at once — the
 * dividers between them say who sent each.
 */
function withOrigin<T extends object>(payload: T, origin: MessageOrigin | undefined): T & { origin?: MessageOrigin } {
  return origin ? { ...payload, origin } : payload
}

/**
 * The ids of the messages a `user_message` carries, on its payload: the event
 * that says "this turn is answering them", which is what arms a sender's
 * watch on its message (see `subscriptions.ts`).
 */
function withMessageIds<T extends object>(payload: T, ids: string[] | undefined): T & { messageIds?: string[] } {
  return ids?.length ? { ...payload, messageIds: ids } : payload
}

/**
 * Adapter processes Domo stopped on purpose, with whether the session keeps
 * its status. A server shutdown stops every adapter, and an idle session is
 * still idle afterwards: nothing it was doing was cut off, and the next
 * message starts it again. Calling that `stopped` read as "did not come back".
 */
const requestedExits = new WeakMap<object, { keepIdle: boolean }>()

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
  /**
   * The watchdog that ends an adapter-initiated turn; see `openAdapterTurn`.
   * Null whenever `this.turn` is Domo's own or there is no turn at all.
   */
  private adapterTurnTimer: ReturnType<typeof setTimeout> | null = null
  /** Resolves the open adapter turn's `done`; null when there is no such turn. */
  private adapterTurnSettle: (() => void) | null = null
  /**
   * Tool calls the open adapter turn has started and not yet heard back about.
   * Only kept during such a turn, and cleared when one opens: a Domo turn ends
   * on its own promise and does not care.
   */
  private openToolCalls = new Set<string>()
  /** Whether codex-acp last said its thread is running a turn; see `codexThreadStatus`. */
  private threadActive = false
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

  /**
   * The startability question, asked against the current rows.
   *
   * Every guard outside `boot()` comes through here, and none of them stat the
   * filesystem: the environment is the part that changes under a session's
   * feet, and the working directory is only worth a syscall on the path that is
   * about to use it.
   */
  private async assertStartable(what: string): Promise<void> {
    const { session, environment } = await getAgentSessionWithEnvironment(this.agentSessionId)
    assertSessionStartable(session, environment, null, what)
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
   * The row claims something the runtime can disprove, so correct it.
   *
   * An adapter that is up with no turn in flight and nobody waiting on a
   * permission is idle — there is no state left for it to be in — and two rows
   * get stuck saying otherwise. `error` is the shape a *failed turn* leaves
   * behind, and `ensureStarted` is a no-op for it, so without this a retry on a
   * session-limit error would change nothing and the banner would stay put.
   * `thinking` is what a turn Domo could not see the end of used to leave
   * behind for ever; nothing can reach that state now, but rows written before
   * the watchdog existed are still out there and a live process will not
   * restart just for them.
   *
   * Only ever called with a reason to look — `acpManager.start`, which is the
   * retry button and the only thing a person can press at a stuck session.
   * There is no sweep, because there is no clock-driven state here to
   * reconcile: what makes the row wrong is a process that is already running,
   * and a restart's own sweep in `server/plugins/boot.ts` catches the rest.
   */
  async reconcileStatus(): Promise<void> {
    if (this.turn || this.waiters.size || !this.alive || !this.acpSessionId) return
    // The *row*, not `this.status`, which is only a memo of what this process
    // last wrote and says nothing about a row left behind by a different one.
    const session = await getAgentSession(this.agentSessionId)
    if (!session || !BUSY_STATUSES.has(session.status)) return
    // `touch` because `setStatus` skips a write that matches its memo, and the
    // memo is exactly what is not to be trusted here.
    await this.setStatus('idle', { lastError: null, touch: true })
  }

  private async boot(): Promise<void> {
    const { session, environment: named } = await getAgentSessionWithEnvironment(this.agentSessionId)
    if (!session) throw new Error(`Agent session ${this.agentSessionId} not found`)
    // Before anything is spawned, and before the row is touched. Every path
    // that can bring an adapter up arrives at `ensureStarted` and therefore
    // here, so this is the one check that cannot be routed around; the nearer
    // guards elsewhere exist to give a better message, not to close a hole.
    //
    // This is also the only caller that stats the working directory. A host
    // session whose directory has been deleted used to have it silently
    // recreated, empty, and the agent would work in it — creating the directory
    // belongs to `create()`, where somebody actually asked for it.
    const cwdPresent = session.devEnvironmentId
      ? null
      : await access(session.cwd).then(() => true, () => false)
    assertSessionStartable(session, named, cwdPresent, 'starting its adapter')

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
      const requested = requestedExits.get(proc)
      this.connection = null
      this.acpSessionId = null
      this.booting = null
      this.proc = null
      this.containerName = null
      this.containerPidFile = null
      for (const waiter of this.waiters.values()) waiter.resolve(null)
      this.waiters.clear()
      this.threadActive = false
      // Nothing is running any more, so a watchdog still armed would fire
      // against a dead connection and write `turn_end` under `adapter-exit`.
      this.discardAdapterTurn()
      const block = this.takeStream()
      void this.serial(async () => {
        await this.closeStream(block)
        await this.flushUsage()
        // `requested`: Domo stopped it, which nobody following the agent needs
        // to be told about — a shutdown stops all of them at once.
        await appendAgentEvent(this.agentSessionId, 'adapter-exit', requested ? { code, signal, requested: true } : { code, signal })
        // An adapter that could not start exits, so this handler and the boot
        // failure's own `setStatus('error')` race for the same row — and which
        // of the two lands last is not something the caller should have to
        // guess at. The error is the one that says *why*, and `lastError` beside
        // it is what the UI offers a retry on, so it wins either way.
        if (this.status === 'error') return
        if (requested?.keepIdle && this.status === 'idle') return
        await this.setStatus('stopped')
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
    // `_meta` and not in `agentCapabilities`. claude-agent-acp and codex-acp
    // set it; OpenCode does not, and gets `interrupt` where it would have got
    // `steer`. It is recorded on the row for the same reason `config_options`
    // is: the composer has to be able to say what a `steer` will really do, and
    // the only other way to find out is to start an adapter and ask it.
    this.steering = initialized?._meta?.steering?.supported === true

    // The mesh is an HTTP MCP server now; an adapter that cannot speak that
    // transport gets no mesh rather than a server it would fail to connect to.
    const httpMcp = !!initialized?.agentCapabilities?.mcpCapabilities?.http
    if (!httpMcp) warnNoHttpMcp(session.adapter)

    const settings = await getSettings()
    const mcpServers = await this.mcpServersForSession(environment, httpMcp, settings)

    // An assistant's identity and handoff note, for a harness that takes a
    // system prompt. Sent on load as well as new, so a reattach keeps it and a
    // persona edited since takes effect.
    const systemPrompt = await assistantSystemPrompt(session)
    const meta = systemPrompt ? { _meta: { systemPrompt: { append: systemPrompt } } } : {}

    // Everything the adapter says from here until the end of this boot is
    // history, not news. See `restoring`.
    this.restoring = !!session.acpSessionId

    let sessionResponse: any = null
    if (session.acpSessionId) {
      try {
        sessionResponse = await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: session.acpSessionId,
          cwd: session.cwd,
          mcpServers,
          ...meta
        } as any)
        this.acpSessionId = session.acpSessionId
      } catch (error) {
        console.error(`[acp:${this.agentSessionId}] load failed, starting fresh`, error)
      }
    }

    try {
      let fresh = false
      const patch: { acpSessionId?: string, modes?: any, modeId?: string, steering?: boolean } = {}
      // Rides along with the rest of what this attach learned rather than
      // costing a write of its own; `null` on the row means nothing has ever
      // attached, which is a different answer from `false`.
      if (this.steering !== session.steering) patch.steering = this.steering
      if (!this.acpSessionId) {
        const created = (await connection.agent.request(acp.methods.agent.session.new, {
          cwd: session.cwd,
          mcpServers,
          ...meta
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
    // Only if nothing is running. Two things can hold the slot by now: the
    // prompt that started this adapter, and — in the window between clearing
    // `restoring` and here — a turn the agent began on its own. Writing `idle`
    // over either says the session is free when it is working.
    if (!this.turn) await this.setStatus('idle', { touch: true })

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
   * may come back in whatever mode it defaults to (Codex does; Claude Code
   * restores the mode from its own transcript since 0.90.0) — so the mode
   * has to be re-applied from the row on every attach, exactly as the model is
   * (`applyRequestedModel`). Under `pnpm dev` this is not a rare path: every
   * edit to `server/` restarts Nitro and reattaches every session.
   *
   * The row is the authority on what was *asked for* and the adapter on what
   * *is*, so what it answers with is what gets recorded. Returns the columns to
   * write rather than writing them, so a start is one row update.
   *
   * Nothing here appends a `mode_changed` event. That event means "somebody
   * changed the mode": the user or the mesh through `setMode`, or the
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
   * through the mesh or the API would leave a session that could never
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
        // An ambiguous pin is a different problem from a missing one, and
        // saying "does not offer" about a name the adapter offers twice sends
        // the reader looking in the wrong place. OpenCode's two providers
        // share model names and do not share a bill, so name both.
        const ambiguous = ambiguousModelMatches(option, preference)
        const message = ambiguous.length > 1
          ? `${from} "${preference}", which matches more than one model: ${ambiguous.join(', ')}. `
            + 'Name one exactly — they are not interchangeable. '
            + `The session is running on ${chosen?.value ?? 'the adapter’s default'} instead.`
          : `${from} "${preference}", which the adapter does not offer. `
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

    // Before anything that reads it as the agent's: a subagent's work neither
    // opens a turn nor keeps one going, and must not end the message the agent
    // is writing.
    const parent = subagentParent(update)
    if (parent) {
      await this.onSubagentUpdate(kind, update, parent)
      return
    }

    // Before the branches below, because what this decides is whether there is
    // a turn at all. An update arriving with the slot empty is the agent having
    // woken itself; see `noteAdapterActivity`.
    this.noteAdapterActivity(kind, update)

    // Before `takeStream()` and before anything claims a `seq`: this is state,
    // it is not part of the transcript, and it arrives in the middle of the
    // message the agent is still writing.
    if (kind === 'usage_update') {
      this.noteUsage(update)
      if (update.cost) this.noteResult(update)
      return
    }
    // State too, and the row has to follow it as it follows a
    // `current_mode_update`: OpenCode sends one when it refreshes its model
    // catalogue or another client changes the session, and left alone the row
    // went on describing a model and options the adapter no longer had.
    if (kind === 'config_option_update') {
      await this.serial(() => this.takeConfigOptions(update.configOptions))
      return
    }

    // A subagent launched in the background holds the turn's `session/prompt`
    // open until it is done; see `noteResult`.
    if (this.turn?.origin === 'domo' && kind === 'tool_call_update' && update._meta?.claudeCode?.toolResponse?.isAsync === true) {
      this.turn.backgroundAgents = true
    }

    const streamType: AgentStreamType | null
      = kind === 'agent_message_chunk'
        ? 'agent_message'
        : kind === 'agent_thought_chunk' ? 'agent_thought' : null

    if (streamType) {
      const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
      if (!text) return
      if (streamType === 'agent_message') {
        // A new block is a new message: without a break, the summary of a turn
        // with a tool call in it read "…once their branch lands.Nothing clashes".
        if (this.stream?.type !== streamType && this.textBuffer) this.textBuffer += '\n\n'
        this.textBuffer += text
      }
      this.appendStream(streamType, text)
      await this.setStatus('thinking')
      return
    }

    // Detached here, before anything awaits: the block's row has to exist with a
    // lower `seq` than this event, or the transcript would show the text that
    // preceded a tool call after it.
    //
    // A tool call that has not started is the one thing that does not end the
    // text around it. OpenCode announces a part the instant it exists —
    // `pending`, empty `rawInput`, no locations, filled in by a later
    // `tool_call_update` — and that lands *between* two deltas of a sentence
    // still being written, so closing here split one sentence into two bubbles
    // with a tool card wedged between them. A tool that has not run yet cannot
    // have produced anything for the agent to be commenting on, so text that
    // arrives while the newest call is still pending is a continuation of the
    // text before it. Everything else closes the block as before, the first
    // `tool_call_update` included: that one means the tool really started. An
    // adapter that fills a call in immediately sends it before the next delta,
    // so nothing about Claude Code or codex-acp changes.
    //
    // Seq is untouched by this. The block claimed its `seq` at its *first*
    // delta, which is already below this event's, so continuing to write into
    // it renders the whole sentence above the tool card, which is where it
    // belongs.
    const block = kind === 'tool_call' && update.status === 'pending' ? null : this.takeStream()
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

  /**
   * Record a subagent's tool call without treating it as the agent's.
   *
   * It goes in the log as it came, `parentToolUseId` and all, so the transcript
   * can draw it inside the `Agent` call that spawned it. It does not end the
   * agent's open message — the subagent's card renders inside an earlier one,
   * so the message reads on in one piece — and it does not say the session is
   * working: a background subagent outlives the turn that launched it.
   *
   * Everything else a subagent sends is dropped. Its prose and thoughts are
   * not forwarded by claude-agent-acp in practice (checked on 0.81.1), and its
   * answer reaches the agent, which says what it needs to; its plan would
   * replace the agent's own. A progress beat on the `Agent` call itself only
   * counts seconds, and would flip a finished card back to running for good.
   */
  private async onSubagentUpdate(kind: string, update: any, parent: string): Promise<void> {
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return
    if (update.toolCallId === parent) return
    await this.serial(async () => {
      await appendAgentEvent(this.agentSessionId, kind, update)
      if (this.turn) await this.touchIfStale()
    })
  }

  /**
   * A result arrived: the `usage_update` carrying the cost is the one
   * claude-agent-acp sends when Claude Code finishes a run of the model.
   *
   * With a subagent running in the background, that is where the agent's turn
   * ends, but not where its `session/prompt` is answered: claude-agent-acp
   * holds the prompt open until every background subagent the turn launched
   * is done, and Claude Code has answered what they report — minutes later,
   * and the turn would sit at `thinking` with its inbox stranded the whole
   * time. So the turn is released here instead. A prompt sent while the
   * adapter still holds the old one is safe: it settles the old one and runs.
   *
   * Only a result for the prompt itself, never one Claude Code produced on its
   * own: a queued task notification gets a placeholder result before its
   * follow-up runs (see docs/acp-adapters.md).
   */
  private noteResult(update: any): void {
    const turn = this.turn
    if (turn?.origin !== 'domo' || !turn.backgroundAgents) return
    if (AUTONOMOUS_ORIGINS.has(update._meta?.['_claude/origin']?.kind)) return
    turn.release?.()
  }

  /** An adapter's unprompted report of its whole option set: the model, the mode and the rest. */
  private async takeConfigOptions(options: unknown): Promise<void> {
    if (!Array.isArray(options)) return
    const response = { configOptions: options }
    const session = await getAgentSession(this.agentSessionId)
    if (!session) return
    const patch: { model?: string, modeId?: string, configOptions?: SessionConfigOptionInfo[] } = {}

    this.modelOption = modelConfigOption(response) ?? this.modelOption
    const model = currentModel(this.modelOption)?.value
    if (model && model !== session.model) patch.model = model

    // Only an adapter that publishes its modes as an option; the others say
    // so through `current_mode_update`.
    if (this.modeOption) {
      this.modeOption = modeConfigOption(response) ?? this.modeOption
      const modeId = currentModeId(response)
      if (modeId) this.reportedModeId = modeId
      if (modeId && modeId !== session.modeId) patch.modeId = modeId
    }

    this.configOptions = adapterConfigOptions(response)
    if (!sameConfigOptions(this.configOptions, session.configOptions)) patch.configOptions = this.configOptions
    if (Object.keys(patch).length) await updateAgentSession(this.agentSessionId, patch)
  }

  private async onPermission(params: any): Promise<any> {
    const options = (params.options ?? []).map((option: any) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind
    }))
    const title: string = params.toolCall?.title || params.toolCall?.rawInput?.description || 'Tool call'

    // An assistant handing off with Domo's own tool is asking to do what the
    // human or Domo asked of it, and the tool touches nothing but the
    // assistant's sessions. Asking first would put a permission prompt
    // between the "Fresh start" button and the fresh start.
    if (isDomoHandOff(params.toolCall)) {
      const allow = options.find((o: any) => o.kind === 'allow_once') ?? options.find((o: any) => o.kind === 'allow_always')
      if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }

    const block = this.takeStream()
    let answer!: Promise<string | null>
    const permission = await this.serial(async () => {
      await this.closeStream(block)
      const row = await createPermission({
        agentSessionId: this.agentSessionId,
        toolCallId: params.toolCall?.toolCallId ?? null,
        title,
        options,
        toolCall: params.toolCall ?? null
      })
      // The moment the row exists, before anything else awaits: it can be
      // answered from then on. An answer that arrived before the waiter was
      // marked the row resolved and reached nobody, and the agent waited on
      // a permission nobody would ask about again.
      answer = new Promise<string | null>((resolvePromise) => {
        this.waiters.set(row.id, { permission: row, resolve: resolvePromise })
      })
      await appendAgentEvent(this.agentSessionId, 'permission_request', { permissionId: row.id, ...params })
      await this.setStatus('awaiting-permission', { touch: true })
      return row
    })

    const optionId = await answer
    this.waiters.delete(permission.id)

    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    // A background subagent asks with no turn open, and getting its answer
    // does not make the agent busy.
    await this.setStatus(this.turn ? 'thinking' : 'idle')
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

  /* ---------------- turns the adapter starts by itself ---------------- */

  /**
   * Take in an update that may or may not belong to a turn Domo knows about.
   *
   * With no turn in flight nobody prompted this: the agent woke itself, and the
   * only record that it is working at all is the updates themselves. Left
   * alone, the session streams an answer, goes to `thinking`, and stays there
   * for ever — its inbox stranded behind a turn that has no end to hang a drain
   * off, and `list_agents` telling every other agent it is busy.
   */
  private noteAdapterActivity(kind: string, update: any): void {
    // Tracked whoever owns the turn: Codex reports `active` before the first
    // update of a turn it starts, and `idle` after the answer to a prompt.
    const thread = codexThreadStatus(update)
    if (thread) {
      this.threadActive = thread === 'active'
      if (this.turn?.origin !== 'adapter') return
      if (this.threadActive) this.armAdapterTurn()
      else this.onAdapterTurnQuiet()
      return
    }
    if (SESSION_STATE_UPDATES.has(kind)) return
    if (!this.turn) this.openAdapterTurn()
    // Domo's own turns end on their `session/prompt` and want no watchdog.
    if (this.turn?.origin !== 'adapter') return
    this.noteToolCall(kind, update)
    // The agent is still going: push the deadline out.
    this.armAdapterTurn()
  }

  /**
   * Follow which tool calls are still outstanding, so the watchdog can tell a
   * turn that has ended from a command that is taking a while.
   *
   * Only a `tool_call` opens one, and only a terminal status closes it. A
   * `tool_call_update` that is not terminal opens nothing: one with no status
   * is a late content or `_meta` update, and claude-agent-acp sends progress
   * beats as `in_progress` for calls this turn may never have seen start. Read
   * as opening a call, either could hold the turn for as long as the adapter
   * lives, since an open call has no deadline.
   */
  private noteToolCall(kind: string, update: any): void {
    const id = update?.toolCallId
    if (!id) return
    const status = update.status
    if (status === 'completed' || status === 'failed') this.openToolCalls.delete(id)
    else if (kind === 'tool_call') this.openToolCalls.add(id)
  }

  /**
   * Claim the turn slot for a turn the agent started on its own.
   *
   * The slot is the same one `prompt` uses, and deliberately so: `busy`,
   * `deliver`, `drainInbox` and `reconcileStatus` all ask "is a turn running",
   * and every one of them wants the same answer about this one. A second field
   * beside `this.turn` would mean four call sites to keep in step and one of
   * them eventually missed.
   */
  private openAdapterTurn(): void {
    let settle!: () => void
    const turn: Turn = {
      origin: 'adapter',
      interrupted: false,
      settled: false,
      done: new Promise<void>((resolve) => { settle = resolve }),
      // `session/cancel` has already gone out by the time this runs, and
      // `cancel` writes the `cancelled` line and sets the status itself — so
      // all that is left is to stop waiting for an end nothing will announce.
      // Deliberately not `endAdapterTurn`: a cancelled turn gets no `turn_end`,
      // exactly as a cancelled prompted one does not.
      cancel: () => this.discardAdapterTurn()
    }
    // Claimed before the first await, for the reason `prompt` claims its own
    // synchronously: a delivery reading the slot as free in the gap would send
    // a `session/prompt` into a turn that is already running in the adapter,
    // where it lands in the adapter's own invisible queue.
    this.turn = turn
    this.adapterTurnSettle = settle
    this.openToolCalls.clear()
    // Reset for the same reason `runTurn` resets it: what this turn says is
    // what becomes the session summary, and the last turn's text is not it.
    this.textBuffer = ''
    this.armAdapterTurn()

    const block = this.takeStream()
    void this.serial(async () => {
      await this.closeStream(block)
      // The head of the turn, and it has to be the head: a reader meets the
      // agent's text first, and with no `user_message` above it there is
      // nothing to say whether they asked for it. See `turn_start` in
      // `buildTranscript`.
      await appendAgentEvent(this.agentSessionId, 'turn_start', { origin: 'adapter' })
      // Same clearing a prompted turn does, for the same reason: `last_error`
      // describes the current state, and the agent is plainly working.
      await this.setStatus('thinking', { touch: true, lastError: null })
    }).catch(error => console.error(`[acp:${this.agentSessionId}] could not open an agent-started turn`, error))
  }

  /**
   * Push the watchdog's deadline out to the full window from now, or take it
   * away while the adapter says it is still working.
   */
  private armAdapterTurn(): void {
    this.clearAdapterTurnTimer()
    if (this.openToolCalls.size || this.threadActive) return
    const timer = setTimeout(() => this.onAdapterTurnQuiet(), adapterTurnWindows.idle)
    // A pending watchdog must not keep Node alive on its own.
    timer.unref?.()
    this.adapterTurnTimer = timer
  }

  private clearAdapterTurnTimer(): void {
    if (!this.adapterTurnTimer) return
    clearTimeout(this.adapterTurnTimer)
    this.adapterTurnTimer = null
  }

  /** The turn has said nothing for its whole window, or Codex said it is over. */
  private onAdapterTurnQuiet(): void {
    this.clearAdapterTurnTimer()
    const turn = this.turn
    if (turn?.origin !== 'adapter') return
    // A permission is the one wait with no deadline on it, because the thing it
    // is waiting for is a person. Declaring the turn over here would drain the
    // inbox into an adapter parked inside `session/request_permission`, and the
    // session would stop saying what it is blocked on. It terminates by other
    // means every time: the answer, `cancel`, or the adapter
    // exiting — all of which resolve every waiter.
    if (this.waiters.size) {
      this.armAdapterTurn()
      return
    }
    void this.endAdapterTurn(turn)
  }

  /**
   * Close a turn the agent started, as far as Domo can tell.
   *
   * Everything a prompted turn does at its end, minus the one thing there is no
   * source for: a `stopReason` off the wire. The event records `end_turn`
   * because that is what it looks like and what the UI reads as ordinary, and
   * `origin: 'adapter'` beside it is the honest part — it says the end was
   * inferred, and from where.
   */
  private async endAdapterTurn(turn: Turn): Promise<void> {
    if (this.turn !== turn) return
    this.clearAdapterTurnTimer()
    this.turn = null
    const settle = this.adapterTurnSettle
    this.adapterTurnSettle = null

    const block = this.takeStream()
    // Fire-and-forget, and the drain below is not held behind it: the writes
    // are already ordered by `serial`, so a turn the drain starts still lands
    // after this one's `turn_end`.
    void this.serial(async () => {
      await this.closeStream(block)
      await appendAgentEvent(this.agentSessionId, 'turn_end', { stopReason: 'end_turn', origin: 'adapter' })
      await this.setStatus('idle', {
        touch: true,
        summary: this.textBuffer.trim().slice(-1200) || undefined
      })
      await this.flushUsage()
    }).catch(error => console.error(`[acp:${this.agentSessionId}] could not close an agent-started turn`, error))

    settle?.()
    // The whole point of seeing the end: everything that piled up behind a turn
    // nobody started is delivered exactly as it would be after a prompted one.
    this.drainInbox()
  }

  /**
   * Give up on an adapter-initiated turn without ending it, because something
   * that really is a turn is taking the slot.
   *
   * Every path that prompts checks `this.turn` first, so this is a backstop
   * rather than a route — but a watchdog left armed against a slot it no longer
   * owns is the kind of leak that surfaces as a `turn_end` in the middle of
   * somebody else's turn.
   */
  private discardAdapterTurn(): void {
    if (this.turn?.origin !== 'adapter') return
    this.clearAdapterTurnTimer()
    this.turn = null
    const settle = this.adapterTurnSettle
    this.adapterTurnSettle = null
    settle?.()
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
  prompt(content: any[], origin?: MessageOrigin, messageIds?: string[]): Promise<{ stopReason: string }> {
    const controller = new AbortController()
    let settle!: () => void
    const turn: Turn = {
      origin: 'domo',
      interrupted: false,
      settled: false,
      cancel: () => controller.abort(),
      done: new Promise<void>((resolve) => { settle = resolve })
    }
    // A turn the agent started for itself is superseded by one Domo is about to
    // run, and its watchdog must not outlive the slot it was watching.
    this.discardAdapterTurn()
    this.turn = turn

    return this.runTurn(content, turn, controller, origin, messageIds).finally(() => {
      if (this.turn === turn) this.turn = null
      settle()
      // A turn ending — normally, cancelled, or failed — is the other moment
      // the inbox drains.
      this.drainInbox()
    })
  }

  private async runTurn(
    asked: any[],
    turn: Turn,
    controller: AbortController,
    origin?: MessageOrigin,
    messageIds?: string[]
  ): Promise<{ stopReason: string }> {
    await this.assertStartable('sending it a message')
    await this.ensureStarted()
    if (!this.connection || !this.acpSessionId) throw new Error('agent not started')
    // A session of an assistant on a harness without a system prompt gets its
    // identity and handoff note on its first prompt. Recorded as sent, so the
    // log says what the agent really read; the transcript hides the block.
    const session = await getAgentSession(this.agentSessionId)
    const content = session ? await primeFirstPrompt(session, asked) : asked

    this.textBuffer = ''
    const stale = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(stale)
      await appendAgentEvent(this.agentSessionId, 'user_message', withOrigin(withMessageIds({ content }, messageIds), origin))
      // `last_error` is history and the transcript already carries it at the
      // moment it happened; the row's copy describes the *current* state, so a
      // turn starting clears it. Left behind, a failed turn's message outlived
      // the failure and the banner kept describing it.
      await this.setStatus('thinking', { touch: true, lastError: null })
    })

    try {
      const request = this.connection.agent.request(
        acp.methods.agent.session.prompt,
        { sessionId: this.acpSessionId, prompt: content } as any,
        { signal: controller.signal } as any
      )
      const released = new Promise<null>((resolve) => { turn.release = () => resolve(null) })
      const response = (await Promise.race([request, released])) as any
      // Released at its result while the adapter holds the prompt for a
      // background subagent (see `noteResult`). When the adapter answers at
      // last, Claude Code has answered the subagent too, so the turn it
      // started for that is over.
      if (response === null) {
        request.then(() => {
          if (this.turn?.origin === 'adapter' && !this.waiters.size) return this.endAdapterTurn(this.turn)
        }).catch(error =>
          console.error(`[acp:${this.agentSessionId}] a released turn failed`, error))
      }
      // The adapter is done; everything below is Domo's own bookkeeping, and
      // for its duration this turn must not be steered into. See `Turn.settled`.
      turn.settled = true
      // Queued behind any text writes still in flight, so the turn closes last.
      const block = this.takeStream()
      await this.serial(async () => {
        await this.closeStream(block)
        await appendAgentEvent(this.agentSessionId, 'turn_end', { stopReason: response?.stopReason ?? 'end_turn', usage: response?.usage })
        await this.setStatus('idle', {
          touch: true,
          summary: this.textBuffer.trim().slice(-1200) || undefined
        })
        // The turn's final reading is the authoritative one — it is the result
        // that carries the real context window and the session's cost — so it
        // is written now rather than left in a timer a restart would drop.
        await this.flushUsage()
      })
      await this.turnEnded({ content, ok: true, text: this.textBuffer })
      return { stopReason: response?.stopReason ?? 'end_turn' }
    } catch (error) {
      // An `interrupt` aborts this request on purpose and `cancel` has already
      // written the `cancelled` line; calling that an error would put the
      // session in `error` for doing what it was told.
      // Settled first: the turn-end listeners below are bookkeeping too, and a
      // delivery landing while they run must queue, not steer an idle adapter.
      turn.settled = true
      if (turn.interrupted) {
        await this.turnEnded({ content, ok: false, text: this.textBuffer })
        return { stopReason: 'cancelled' }
      }
      const message = error instanceof Error ? error.message : String(error)
      const block = this.takeStream()
      await this.serial(async () => {
        await this.closeStream(block)
        await appendAgentEvent(this.agentSessionId, 'error', { message })
        await this.setStatus('error', { lastError: message, touch: true })
        await this.flushUsage()
      })
      await this.turnEnded({ content, ok: false, text: this.textBuffer })
      throw error
    }
  }

  /**
   * Tell whoever listens that a turn is over, before the inbox drains: an
   * assistant's handoff moves what is waiting to the next session, and it
   * has to get there first. A listener that fails costs a log line, never
   * the turn.
   */
  private async turnEnded(input: Omit<TurnEnd, 'agentSessionId'>): Promise<void> {
    for (const listener of turnEndListeners) {
      try {
        await listener({ agentSessionId: this.agentSessionId, ...input })
      } catch (error) {
        console.error(`[acp:${this.agentSessionId}] turn-end listener failed`, error)
      }
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
    /** The message's id, whichever way it goes in: the inbox row's, or the one its `user_message` names. */
    id?: string
  }): Promise<DeliveryResult> {
    const ids = input.id ? [input.id] : undefined
    return this.serialDeliver(async () => {
      // Ahead of `ensureStarted` so the caller is told *why* rather than being
      // handed a boot failure, and ahead of every branch below so an
      // unstartable session cannot even be queued for — see
      // `enqueueInboxMessage`, which guards the one write that does not come
      // through here.
      await this.assertStartable('sending it a message')
      await this.ensureStarted()

      if (!this.turn) {
        // Something still waiting goes first: a session's first message sits
        // in the inbox while its adapter boots, and a second one sent in that
        // window must not overtake it. The drain sends both, in order.
        if ((await listInboxMessages(this.agentSessionId)).length) {
          const queued = await this.enqueue(input.content, input.delivery, input.origin, input.id)
          this.drainInbox()
          return queued
        }
        const turn = this.prompt(input.content, input.origin, ids)
        turn.catch(error => console.error(`[acp:${this.agentSessionId}] turn failed`, error))
        return { delivery: input.delivery, outcome: 'prompted' as const }
      }

      // The adapter answered and only the bookkeeping is left, so there is
      // nothing here to steer into and nothing to interrupt. All three modes
      // mean the same thing in this window — go next — and the drain queued
      // right behind this turn is what delivers it, in the very next turn.
      // Steering instead would reach an idle adapter, which is how a detached
      // turn nobody can see the end of gets started.
      if (this.turn.settled) return this.enqueue(input.content, input.delivery, input.origin, input.id)

      switch (input.delivery) {
        case 'queue':
          return this.enqueue(input.content, 'queue', input.origin, input.id)
        case 'interrupt':
          return this.interruptWith(input.content, input.origin, input.id)
        default:
          return this.steerInto(input.content, input.origin, input.id)
      }
    })
  }

  private async enqueue(
    content: any[],
    delivery: MessageDelivery,
    origin: MessageOrigin,
    id?: string
  ): Promise<DeliveryResult> {
    const row = await enqueueInboxMessage({
      agentSessionId: this.agentSessionId,
      content,
      delivery,
      origin,
      id
    })
    return { delivery, outcome: 'queued', inboxId: row.id }
  }

  /** Cancel what is running, wait for it to settle, then prompt. */
  private async interruptWith(content: any[], origin: MessageOrigin, id?: string): Promise<DeliveryResult> {
    const running = this.turn
    if (running) {
      running.interrupted = true
      await this.cancel()
      await running.done
    }
    // The drain that turn kicked off is queued behind this critical section, so
    // it finds the slot taken and leaves the queue for the turn below.
    const turn = this.prompt(content, origin, id ? [id] : undefined)
    turn.catch(error => console.error(`[acp:${this.agentSessionId}] turn failed`, error))
    return { delivery: 'interrupt', outcome: 'prompted' }
  }

  /** Inject into the running turn, or fall back when the adapter cannot. */
  private async steerInto(content: any[], origin: MessageOrigin, id?: string): Promise<DeliveryResult> {
    // "Change course now" is what was asked for, and queueing is the one thing
    // it definitely does not mean.
    if (!this.steering) return this.interruptWith(content, origin, id)

    // The turn settled inside the adapter between our check and the request,
    // or the request failed. Queue rather than prompt: our own
    // `session/prompt` may still be in flight, and its end is what drains the
    // queue a moment later.
    if (!(await this.steerRequest(content))) return this.enqueue(content, 'steer', origin, id)

    await this.recordSteer(content, origin, id ? [id] : undefined)
    return { delivery: 'steer', outcome: 'steered' }
  }

  /** Ask the adapter to take this into the turn it is running. False when it did not. */
  private async steerRequest(content: any[]): Promise<boolean> {
    try {
      const response = (await this.connection!.agent.request(STEERING_METHOD, {
        sessionId: this.acpSessionId,
        prompt: content,
        _meta: STEERING_META
      } as any)) as any
      const outcome = String(response?.outcome ?? 'failed')
      return outcome !== 'promptRequired' && outcome !== 'failed'
    } catch (error) {
      console.error(`[acp:${this.agentSessionId}] steering failed`, error)
      return false
    }
  }

  /**
   * The message joined the running turn, so the transcript has to show it in
   * its place — the agent is about to answer it.
   */
  private async recordSteer(content: any[], origin: MessageOrigin, ids?: string[]): Promise<void> {
    const block = this.takeStream()
    await this.serial(async () => {
      await this.closeStream(block)
      await appendAgentEvent(this.agentSessionId, 'user_message', withOrigin(withMessageIds({ content, delivery: 'steer' }, ids), origin))
      await this.touchIfStale()
    })
  }

  /**
   * Hand over what is queued now instead of when the turn ends: the
   * composer's "send queued now". The same two paths a message sent with
   * that mode takes, applied to the rows that are waiting.
   *
   * `steer` injects them one at a time, oldest first, each as its own
   * message with its own sender. The first one the adapter does not take —
   * the turn ended under it, or the request failed — stops the run, and it
   * and the rest go back to waiting under their own ids and places, for the
   * drain at the turn's end. `interrupt` cancels the turn and prompts them as
   * one turn, exactly as the drain would. An adapter that cannot steer gets
   * `interrupt`, as `deliver` does.
   */
  deliverQueued(delivery: 'steer' | 'interrupt'): Promise<QueuedDeliveryResult> {
    return this.serialDeliver(async () => {
      await this.assertStartable('sending it what is queued')
      await this.ensureStarted()
      const waiting = async () => (await listInboxMessages(this.agentSessionId)).length

      // Nothing running: the queue goes now as one turn, which is what the
      // drain does. A turn that is only settling drains right behind this.
      if (!this.turn) return { delivery, delivered: await this.promptWaiting(), waiting: await waiting() }
      if (this.turn.settled) return { delivery, delivered: 0, waiting: await waiting() }

      if (delivery === 'interrupt' || !this.steering) {
        const running = this.turn
        running.interrupted = true
        await this.cancel()
        await running.done
        // The drain `cancel` asked for is queued behind this, and finds the
        // slot taken by the turn below.
        return { delivery: 'interrupt', delivered: await this.promptWaiting(), waiting: await waiting() }
      }

      const claimed = await claimInboxMessages(this.agentSessionId)
      let steered = 0
      for (const message of claimed) {
        if (!(await this.steerRequest(message.content))) break
        await this.recordSteer(message.content, message.origin, [message.id])
        steered += 1
      }
      await releaseInboxMessages(claimed.slice(steered))
      return { delivery: 'steer', delivered: steered, waiting: await waiting() }
    })
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
      await this.promptWaiting()
    }).catch(error => console.error(`[acp:${this.agentSessionId}] could not drain the inbox`, error))
  }

  /** Claim what is waiting and prompt it as one turn. How many went; inside `serialDeliver` only. */
  private async promptWaiting(): Promise<number> {
    const waiting = await claimInboxMessages(this.agentSessionId)
    if (!waiting.length) return 0
    // The claim is a round trip, and a turn the agent starts for itself takes
    // the slot synchronously from `onUpdate` — which is not serialised with
    // deliveries, so it can land inside that gap. Prompting anyway would send
    // a `session/prompt` into a running turn, where the adapter queues it out
    // of sight. Put them back instead: they are still waiting, in order, and
    // the turn that took the slot drains them when it ends.
    if (this.turn) {
      await releaseInboxMessages(waiting)
      return 0
    }
    // Several messages carry their senders in the dividers between them.
    const turn = this.prompt(
      combineInboxContent(waiting),
      waiting.length === 1 ? waiting[0]!.origin : undefined,
      waiting.map(message => message.id)
    )
    // Anything that arrives *during* this turn is drained when it ends.
    turn.catch(error => console.error(`[acp:${this.agentSessionId}] queued turn failed`, error))
    return waiting.length
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
    // A prompted turn drains from `prompt`'s `finally`; one the agent started
    // has no such promise to hang it off, so the drain is asked for here. It is
    // a no-op when something has already taken the slot — an `interrupt` is
    // exactly that, and its own turn drains the queue when it ends.
    this.drainInbox()
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
    // startability guard sits. These three no longer start an adapter — that is
    // the point of `liveConnection()` — so a session that can never run again
    // would otherwise take the offline branch and quietly write a row
    // describing how it would run.
    await this.assertStartable('changing its settings')

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
      // What the transcript shows; the id alone is the adapter's ("bypassPermissions").
      ...modeName(session?.modes, effective),
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
    // startability guard sits. These three no longer start an adapter — that is
    // the point of `liveConnection()` — so a session that can never run again
    // would otherwise take the offline branch and quietly write a row
    // describing how it would run.
    await this.assertStartable('changing its settings')

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
      const ambiguous = ambiguousModelMatches(this.modelOption, model)
      throw new Error(
        ambiguous.length > 1
          ? `"${model}" matches more than one model this adapter offers: ${ambiguous.join(', ')}. `
            + 'Name one exactly — they are not interchangeable.'
          : `This session's adapter does not offer a model matching "${model}". `
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
    // startability guard sits. These three no longer start an adapter — that is
    // the point of `liveConnection()` — so a session that can never run again
    // would otherwise take the offline branch and quietly write a row
    // describing how it would run.
    await this.assertStartable('changing its settings')

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

  stop(options: { keepIdle?: boolean } = {}): void {
    if (this.proc) requestedExits.set(this.proc, { keepIdle: !!options.keepIdle })
    // A turn cut off on purpose is not a failure: without this it ended as an
    // `error` ("ACP connection closed"), and every follower was told so.
    if (this.turn) this.turn.interrupted = true
    this.discardAdapterTurn()
    this.threadActive = false
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

/** A turn that has just ended, normally (`ok`) or not (failed, cancelled, interrupted). */
export interface TurnEnd {
  agentSessionId: string
  /** What the turn was prompted with, as sent. */
  content: any[]
  ok: boolean
  /** Everything the agent said in it. */
  text: string
}

type TurnEndListener = (turn: TurnEnd) => Promise<void> | void

/**
 * Who hears about turn ends. Module state on `globalThis` rather than on the
 * manager, so a listener registered by a module the manager does not import
 * (assistants, which import the manager) survives a hot reload of either.
 */
const turnEndListeners: Set<TurnEndListener>
  = (globalThis as any).__domo_turn_end_listeners__ ??= new Set<TurnEndListener>()

const warnedNoHttpMcp = new Set<AgentAdapter>()

/** Said once per adapter: a storm of this would drown the adapter's own output. */
function warnNoHttpMcp(adapter: AgentAdapter): void {
  if (warnedNoHttpMcp.has(adapter)) return
  warnedNoHttpMcp.add(adapter)
  console.warn(
    `[acp] the ${adapter} adapter does not advertise HTTP MCP support `
    + '(agentCapabilities.mcpCapabilities.http), so its sessions get no agent mesh: '
    + 'they cannot list, message or spawn peers, or notify the human. '
    + 'Upgrade the adapter to restore it.'
  )
}

/** The environment a session is about to be created in, checked but not started. */
async function environmentForNewSession(id: string): Promise<DevEnvironment> {
  const environment = await getDevEnvironment(id)
  if (!environment) throw new Error('Development environment not found')
  assertNotRetired(environment)
  return environment
}

/** How far back `resume` looks for messages left waiting by a restart. */
const RESUME_WINDOW_MS = 60 * 60_000

/** The statuses a restart interrupts. */
const WORKING = new Set<AgentSessionStatus>(['starting', 'thinking', 'awaiting-permission'])

class AcpManager {
  private runtimes = new Map<string, AgentRuntime>()
  /** Set by `shutdown`, cleared by `resume`: the manager outlives a dev-server reload. */
  private closing = false

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
    modeId?: string | null
    /** Model id for *this* session; omitted means the install default, then the adapter's. */
    model?: string | null
    devEnvironmentId?: string | null
    initialPrompt?: string
    /**
     * The first message, as prompt content — attachments included — for a
     * session started by writing to it. Unlike `initialPrompt` it does not wait
     * for the adapter: the row and the message are written and the call
     * returns, so the page can move onto the session while it boots. The
     * message waits in the inbox, which the attach drains — so a boot that
     * fails leaves it there, visible, for the retry to deliver.
     */
    firstMessage?: any[]
    /** The adapter's own settings (effort and the like), by option id. */
    config?: Record<string, string> | null
    /** The agent spawning this one over the mesh. */
    spawnedBy?: string | null
    /** The assistant this session belongs to. */
    assistantId?: string | null
    /** Written before the adapter starts, so a system prompt built at attach can read it. */
    firstEvent?: { type: string, payload: any }
    /**
     * Settles when `devEnvironmentId`, still being created, is running or has
     * failed. The session is written at once, waiting for it with its first
     * message in the inbox, and starts when it is up; a failed build is its error.
     */
    environmentBuilt?: Promise<unknown>
  }): Promise<AgentSession> {
    const settings = await getSettings()
    const firstMessage = input.firstMessage?.length ? input.firstMessage : null
    // Starting the container is the boot's job too, so a session started by its
    // first message does not wait for it here: the row is all the page needs.
    const environment = input.devEnvironmentId
      ? firstMessage || input.environmentBuilt
        ? await environmentForNewSession(input.devEnvironmentId)
        : await ensureEnvironmentRunning(input.devEnvironmentId)
      : null
    const cwd = environment?.workspacePath ?? normalizeCwd(input.cwd || settings.defaultCwd)
    // Asking for an agent in a directory that does not exist yet is a real and
    // supported thing to do ("start an agent in ~/code/new-thing"). Creating it
    // here rather than in `boot()` is what lets the start path treat a missing
    // directory as a reason to refuse instead of silently making an empty one.
    if (!environment) await mkdir(cwd, { recursive: true }).catch(() => {})
    const words = firstMessage?.find(block => block?.type === 'text' && typeof block.text === 'string')?.text
    // Without a title of its own the session is called by its first words
    // until a generated title replaces them.
    const named = input.title?.trim()
    const opening = input.initialPrompt?.trim() || words?.trim()
    const session = await createAgentSession({
      adapter: input.adapter ?? 'claude-code',
      title: titleFrom(named || opening || UNTITLED_AGENT_TITLE),
      titlePlaceholder: !named,
      cwd,
      modeId: input.modeId ?? settings.defaultAgentModes[input.adapter ?? 'claude-code'],
      model: input.model?.trim() || null,
      devEnvironmentId: environment?.id ?? null,
      spawnedBy: input.spawnedBy ?? null,
      assistantId: input.assistantId ?? null,
      config: input.config ?? null
    })
    if (!named && opening) nameSessionInBackground(session.id, opening)
    if (input.environmentBuilt) {
      const content = firstMessage ?? (input.initialPrompt ? [{ type: 'text', text: input.initialPrompt }] : null)
      if (content) {
        await enqueueInboxMessage({
          agentSessionId: session.id,
          content,
          delivery: 'queue',
          origin: input.spawnedBy ? `agent:${input.spawnedBy}` : 'user'
        })
      }
      await appendAgentEvent(session.id, 'environment_pending', { environmentId: environment!.id, name: environment!.name })
      void input.environmentBuilt.then(
        // The attach drains the inbox, which delivers the first message.
        () => this.runtime(session.id).ensureStarted(),
        async (error) => {
          const message = `Its development environment "${environment!.name}" could not be created: `
            + `${error instanceof Error ? error.message : String(error)}`
          await updateAgentSession(session.id, { status: 'error', lastError: message })
          await appendAgentEvent(session.id, 'error', { message })
        }
      ).catch(error => console.error(`[acp:${session.id}] could not start in its new environment`, error))
      return session
    }
    if (firstMessage) {
      await enqueueInboxMessage({ agentSessionId: session.id, content: firstMessage, delivery: 'queue', origin: 'user' })
      // A failed boot is on the row and in the transcript; the caller has its session either way.
      void this.runtime(session.id).ensureStarted().catch(() => {})
      return session
    }
    if (input.firstEvent) await appendAgentEvent(session.id, input.firstEvent.type, input.firstEvent.payload)
    // A failed boot is recorded on the session row (status + lastError) so the
    // UI can show it and offer a retry instead of blowing up the request.
    const started = await this.runtime(session.id)
      .ensureStarted()
      .then(() => true)
      .catch(() => false)

    if (started && input.initialPrompt) {
      void this.promptInBackground(
        session.id,
        [{ type: 'text', text: input.initialPrompt }],
        input.spawnedBy ? `agent:${input.spawnedBy}` : 'user'
      )
    }
    return (await getAgentSession(session.id))!
  }

  async start(agentSessionId: string): Promise<void> {
    const runtime = this.runtime(agentSessionId)
    await runtime.ensureStarted()
    // A failed boot clears the error in `boot()`; a failed turn — and a turn
    // from before the watchdog that never ended — leave a live adapter, which
    // `ensureStarted` has nothing to do about.
    await runtime.reconcileStatus()
  }

  /** Fire-and-forget turn: the UI and the voice bar follow it through events. */
  async promptInBackground(agentSessionId: string, content: any[], origin?: MessageOrigin): Promise<void> {
    const runtime = this.runtime(agentSessionId)
    try {
      await runtime.prompt(content, origin)
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
   * Every way of reaching a coding agent — the prompt endpoint, the voice bar,
   * the mesh tool, a subscription note — comes through here, so "what happens
   * to a message that arrives mid-turn" is decided in one place.
   */
  async deliver(
    agentSessionId: string,
    input: { content: any[], delivery?: MessageDelivery, origin?: MessageOrigin, id?: string }
  ): Promise<DeliveryResult & { agentSessionId: string }> {
    // A session of an assistant that has handed off is a closed chapter; what
    // is said to it is said to the assistant, whose current session takes it.
    agentSessionId = await currentSessionFor(agentSessionId)
    // A session started with no title and no prompt (Talk, or a bare New
    // agent) is named by the first thing said to it, as a person would.
    const origin = input.origin ?? 'user'
    const words = input.content.find(block => block?.type === 'text' && typeof block.text === 'string')?.text
    if ((origin === 'user' || origin === 'voice') && words?.trim()) {
      const first = await titleUntitledAgentSession(agentSessionId, titleFrom(words)).catch(() => false)
      if (first) nameSessionInBackground(agentSessionId, words)
    }
    const result = await this.runtime(agentSessionId).deliver({
      content: input.content,
      delivery: input.delivery ?? 'steer',
      origin: input.origin ?? 'user',
      id: input.id
    })
    return { ...result, agentSessionId }
  }

  /** Hand over what is queued for a working agent now; see `AgentRuntime.deliverQueued`. */
  async deliverQueued(agentSessionId: string, delivery: 'steer' | 'interrupt'): Promise<QueuedDeliveryResult> {
    return this.runtime(agentSessionId).deliverQueued(delivery)
  }

  /** Hear about every turn end. Returns the unsubscribe. */
  onTurnEnd(listener: TurnEndListener): () => void {
    turnEndListeners.add(listener)
    return () => turnEndListeners.delete(listener)
  }

  /** Hand over anything waiting, if the agent is free to take it. */
  drainInbox(agentSessionId: string): void {
    this.runtimes.get(agentSessionId)?.drainInbox()
  }

  /**
   * Hand over anything waiting, starting the adapter if it is not running:
   * the attach drains the inbox. What a note to an agent needs, because the
   * agent it is for is most often not running — every adapter is gone after a
   * restart, and its subscriber is often idle and asleep.
   *
   * Never while the server is shutting down, or every note written as the
   * adapters go down would start a fresh one.
   */
  wake(agentSessionId: string): void {
    const runtime = this.runtimes.get(agentSessionId)
    if (runtime?.alive) return runtime.drainInbox()
    if (this.closing) return
    void this.runtime(agentSessionId).ensureStarted()
      .catch(error => console.error(`[acp:${agentSessionId}] could not start to deliver its inbox`, error))
  }

  /**
   * After a boot, deliver what was left waiting: nothing is running to drain
   * it, so a note that reached an agent just before the restart would sit
   * there until somebody opened the session. Only messages from the last
   * hour: an old one on a session nobody has used since is not a reason to
   * start it now.
   */
  async resume(now = new Date()): Promise<void> {
    this.open()
    const since = new Date(now.getTime() - RESUME_WINDOW_MS).toISOString()
    for (const id of await listSessionsWithPendingInbox(since)) this.wake(id)
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

  /** Undo `shutdown`'s refusal to start adapters, for a server that is running again. */
  open(): void {
    this.closing = false
  }

  async shutdown() {
    this.closing = true
    for (const [id, runtime] of [...this.runtimes]) {
      runtime.stop({ keepIdle: true })
      this.runtimes.delete(id)
    }
    // Only what was cut off is `stopped`; an idle session stays idle, as one
    // left by a crash does (see `requestedExits`).
    const sessions = await listAgentSessions()
    for (const session of sessions) {
      if (WORKING.has(session.status)) {
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
