/**
 * In-process session engine (Decided #7). Single-flight per-session
 * manager over a long-lived per-session `claude` process. Replaces the
 * pre-pivot Electric Agents stack — no entity, no agents-server, no
 * durable-stream sidecar, no pull-wake runner. The corruption class the
 * old stack had (a stateful intermediary whose memory diverged from
 * durable state across a restart) **does not exist** here: the only
 * stateful peer is the child `claude`, which is a child of *this* process
 * — when it dies, the whole turn is dead, and SQLite is intact.
 *
 * Lifecycle per session:
 *   1. `prompt()` with no process → spawn (with `--resume <nativeId>` if
 *      we have one). Append the `prompt` event. Start the turn.
 *   2. `prompt()` with a process and a live turn → **steer**: inject the
 *      message via `--replay-user-messages`, append a durable `steer_sent`.
 *   3. `prompt()` with a process and no live turn → write the next user
 *      message on the same stdin (multi-turn on one process).
 *   4. After `result` and no new prompts for ~15 min → close stdin → the
 *      process exits cleanly; next prompt respawns with `--resume`.
 *   5. `abort()` → SIGTERM. The process dies, the turn promise resolves,
 *      we append `aborted`. Next prompt respawns.
 *
 * Boot reconcile (called from a Nitro plugin on startup):
 *   - Every session with cached `status='active'`/`pending-approval` flips
 *     to `waiting` (no child is alive after a restart).
 *   - Every `pending_diffs` row with status `pending` flips to `rejected`
 *     + a `diff_decision { reason:'runtime restarted' }` event lands so
 *     the card clears cross-device. The interrupted turn re-runs on the
 *     next prompt and may re-propose a fresh, actionable diff.
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  spawnClaudeProcess,
  type ClaudeProc,
  type PermissionDecision,
  type PermissionRequest,
} from './claude'
import {
  appendEvent,
  getPendingDiff,
  insertPendingDiff,
  listPendingDiffs,
  rejectAllPending,
  setPendingDiffStatus,
  type PendingDiffRow,
  type SessionEventRow,
  type SessionEventType,
} from './store'
import { getSession, listAllSessions, updateSession } from '../sessions'
import { loadDomoConfig } from '../config'
import { expandInWorktree } from '../promptExpand'
import { getEnv } from '../envs'
import { changeBus } from '../changeBus'
import type { ApprovalMode, SessionStatus } from '../schemas'

// ─── Per-session in-process state ────────────────────────────────────────

interface DiffWaiter {
  resolve: (accepted: boolean) => void
  meta: { path: string; before: string; after: string; tabName: string }
}

interface QueuedPrompt {
  text: string
  resolve: () => void
  reject: (err: unknown) => void
}

interface SessionProc {
  sessionId: string
  cwd: string
  proc: ClaudeProc
  /** Active turn's abort controller (SIGTERMs the process). */
  abortCtl: AbortController | null
  /** Mid-turn steer writer — set while a turn is live. */
  steer: ((text: string, uuid: string) => void) | null
  /** Parked diff approvals (manual mode). callId → waiter. */
  diffs: Map<string, DiffWaiter>
  /** Prompts received while a turn is mid-flight (rare — usually steered). */
  queue: QueuedPrompt[]
  idleTimer: NodeJS.Timeout | null
}

const procs = new Map<string, SessionProc>()

const IDLE_REAP_MS = 15 * 60 * 1000

const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Update',
])

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Worktree-relative when the edit is inside cwd; absolute otherwise. */
function relWorktree(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) ? rel : abs
}

/**
 * Reconstruct the proposed file change from a tool's permission-request
 * input, for the durable `pending_diffs` UI. The CLI itself applies the
 * edit on allow — this is display-only.
 */
async function proposeEdit(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ path: string; before: string; after: string }> {
  const rawPath = String(
    input.file_path ?? input.notebook_path ?? input.path ?? '',
  )
  const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
  let before = ''
  try {
    before = await readFile(abs, 'utf8')
  } catch {
    /* new file */
  }
  let after = before
  if (toolName === 'Write') {
    after = String(input.content ?? '')
  } else if (toolName === 'Edit' || toolName === 'Update') {
    const oldS = String(input.old_string ?? '')
    const newS = String(input.new_string ?? '')
    after =
      input.replace_all === true
        ? before.split(oldS).join(newS)
        : before.replace(oldS, newS)
  } else if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<Record<string, unknown>>)
      : []
    after = edits.reduce((acc, e) => {
      const o = String(e.old_string ?? '')
      const n = String(e.new_string ?? '')
      return e.replace_all === true
        ? acc.split(o).join(n)
        : acc.replace(o, n)
    }, before)
  } else if (toolName === 'NotebookEdit') {
    after = String(input.new_source ?? before)
  }
  return { path: relWorktree(cwd, abs), before, after }
}

/** Append + emit on the change bus. Single chokepoint for SSE delivery. */
function recordEvent(
  sessionId: string,
  type: SessionEventType,
  payload: Record<string, unknown>,
): SessionEventRow {
  const row = appendEvent({ sessionId, type, payload })
  changeBus().emitSessionEvent({
    sessionId,
    seq: row.seq,
    type: row.type,
  })
  return row
}

/**
 * Emit a coalesced partial frame on the change bus — **live-only**, not
 * persisted. The complete `assistant` envelope arrives on the durable
 * channel and supersedes the partial in the adapter (matched by
 * Anthropic `message.id`). A reconnecting browser that missed an
 * in-flight delta just doesn't see it; the next flush (or the final
 * `assistant` row) is the source of truth.
 */
function emitPartial(
  sessionId: string,
  messageId: string,
  text: string,
  thinking: string,
): void {
  changeBus().emitSessionPartial({
    sessionId,
    messageId,
    text,
    thinking,
    createdAt: Date.now(),
  })
}

function setStatus(sessionId: string, status: SessionStatus): void {
  try {
    updateSession(sessionId, { status, lastEventAt: Date.now() })
  } catch {
    /* row may be deleted mid-turn — cached status is non-authoritative */
  }
}

function touchLastEvent(sessionId: string): void {
  try {
    updateSession(sessionId, { lastEventAt: Date.now() })
  } catch {
    /* see setStatus */
  }
}

function resetIdleReap(sp: SessionProc): void {
  if (sp.idleTimer) clearTimeout(sp.idleTimer)
  sp.idleTimer = setTimeout(() => {
    // Idle reap: close stdin → process exits cleanly. The map entry is
    // cleared from the exit handler so the next prompt respawns with
    // `--resume <nativeSessionId>`.
    sp.proc.close()
  }, IDLE_REAP_MS)
}

// ─── Streaming coalescer (per turn) ──────────────────────────────────────

interface Coalescer {
  handle: (envelope: Record<string, unknown>) => void
  flushFinal: () => void
}

/**
 * Coalesce `--include-partial-messages` `stream_event` deltas (raw
 * Anthropic streaming events) into a throttled live frame on the change
 * bus. The chat renders text/thinking as it streams without flooding
 * either the wire or `session_events`. The final complete `assistant`
 * envelope arrives separately on the durable channel and supersedes the
 * partial in the adapter (matched by `message.id`).
 *
 * The 100 ms throttle is for wire efficiency (≤10 frames/sec, each
 * carrying the cumulative text — not individual deltas — so the
 * payload grows but the rate stays bounded). Faster than the eye can
 * follow either way.
 */
function makeCoalescer(sessionId: string): Coalescer {
  let msgId: string | null = null
  let text = ''
  let thinking = ''
  let dirty = false
  let lastFlush = 0
  const FLUSH_MS = 100

  function flush(force: boolean): void {
    if (!msgId || !dirty) return
    const now = Date.now()
    if (!force && now - lastFlush < FLUSH_MS) return
    lastFlush = now
    dirty = false
    emitPartial(sessionId, msgId, text, thinking)
  }

  function handle(envelope: Record<string, unknown>): void {
    const ev = (envelope as { event?: Record<string, unknown> }).event
    const et = typeof ev?.type === 'string' ? ev.type : ''
    if (et === 'message_start') {
      const id = (ev?.message as { id?: unknown } | undefined)?.id
      msgId = typeof id === 'string' ? id : null
      text = ''
      thinking = ''
      dirty = false
      lastFlush = 0
      return
    }
    if (et === 'content_block_delta') {
      const d = ev?.delta as
        | { type?: string; text?: string; thinking?: string }
        | undefined
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        text += d.text
        dirty = true
        flush(false)
      } else if (
        d?.type === 'thinking_delta' &&
        typeof d.thinking === 'string'
      ) {
        thinking += d.thinking
        dirty = true
        flush(false)
      }
      return
    }
    if (
      et === 'content_block_stop' ||
      et === 'message_delta' ||
      et === 'message_stop'
    ) {
      flush(true)
    }
  }

  return { handle, flushFinal: () => flush(true) }
}

// ─── Per-turn execution ──────────────────────────────────────────────────

interface RunTurnArgs {
  sp: SessionProc
  prompt: string
  approvalMode: ApprovalMode
}

async function runOneTurn({
  sp,
  prompt,
  approvalMode,
}: RunTurnArgs): Promise<void> {
  const sessionId = sp.sessionId
  const ac = new AbortController()
  sp.abortCtl = ac

  const coalescer = makeCoalescer(sessionId)

  // Re-read approval mode FRESH each turn (per-session override → operator
  // default → `manual`) so toggles apply on the next turn with no restart.
  const onPermissionRequest = async (
    req: PermissionRequest,
  ): Promise<PermissionDecision> => {
    if (approvalMode !== 'manual' || !EDIT_TOOLS.has(req.toolName)) {
      return { behavior: 'allow', updatedInput: req.input }
    }
    const callId = req.requestId
    const { path, before, after } = await proposeEdit(
      sp.cwd,
      req.toolName,
      req.input,
    )
    const tabName = `${req.toolName} ${path}`
    insertPendingDiff({
      sessionId,
      callId,
      path,
      before,
      after,
      tabName,
      status: 'pending',
      createdTs: Date.now(),
    })
    // Include before/after in the event payload so the chat approval
    // card renders directly from the SSE-replayed transcript with no
    // extra procedure round-trip; the durable `pending_diffs` row backs
    // the workspace full-diff view + restart-resume.
    recordEvent(sessionId, 'pending_diff', {
      callId,
      path,
      tabName,
      before,
      after,
    })
    setStatus(sessionId, 'pending-approval')

    const accepted = await new Promise<boolean>((resolveDecision) => {
      sp.diffs.set(callId, {
        resolve: resolveDecision,
        meta: { path, before, after, tabName },
      })
    })

    setPendingDiffStatus(sessionId, callId, accepted ? 'accepted' : 'rejected')
    recordEvent(sessionId, 'diff_decision', {
      callId,
      decision: accepted ? 'accept' : 'reject',
    })
    setStatus(sessionId, 'active')

    return accepted
      ? { behavior: 'allow', updatedInput: req.input }
      : { behavior: 'deny', message: 'Rejected by the user' }
  }

  const onPermissionCancel = (requestId: string): void => {
    // The CLI withdrew the request — settle the park so the card clears.
    const w = sp.diffs.get(requestId)
    if (!w) return
    sp.diffs.delete(requestId)
    w.resolve(false)
    const row = getPendingDiff(sessionId, requestId)
    if (row && row.status === 'pending') {
      setPendingDiffStatus(sessionId, requestId, 'rejected')
      recordEvent(sessionId, 'diff_decision', {
        callId: requestId,
        decision: 'reject',
        reason: 'cli cancelled',
      })
    }
  }

  setStatus(sessionId, 'active')

  // Expand custom slash commands + `@`-mentions at execution time (the
  // transcript keeps the raw `prompt` event the user typed).
  const resolved = await expandInWorktree(sp.cwd, prompt)

  try {
    await sp.proc.runTurn({
      prompt: resolved,
      signal: ac.signal,
      onPermissionRequest,
      onPermissionCancel,
      onSessionId: (id) => {
        const cur = getSession(sessionId)
        if (cur?.nativeClaudeSessionId !== id) {
          updateSession(sessionId, { nativeClaudeSessionId: id })
        }
      },
      onReady: (steerWrite) => {
        sp.steer = (text, uuid) => {
          recordEvent(sessionId, 'steer_sent', { text, uuid })
          steerWrite(text, uuid)
        }
      },
      onEvent: (type, envelope) => {
        if (type === 'stream_event') {
          coalescer.handle(envelope)
          return
        }
        recordEvent(sessionId, type, envelope)
      },
    })
    if (ac.signal.aborted) {
      recordEvent(sessionId, 'aborted', {})
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    coalescer.flushFinal()
    recordEvent(sessionId, 'error', { message })
    setStatus(sessionId, 'error')
    throw e
  } finally {
    coalescer.flushFinal()
    sp.abortCtl = null
    sp.steer = null
    // Settle any still-parked diffs as rejected (defensive — the CLI may
    // have died mid-park; the runtime restart path takes over otherwise).
    for (const [callId, w] of sp.diffs) {
      sp.diffs.delete(callId)
      w.resolve(false)
      const row = getPendingDiff(sessionId, callId)
      if (row && row.status === 'pending') {
        setPendingDiffStatus(sessionId, callId, 'rejected')
        recordEvent(sessionId, 'diff_decision', {
          callId,
          decision: 'reject',
          reason: 'turn ended',
        })
      }
    }
  }
}

// ─── Process lifecycle ───────────────────────────────────────────────────

function effectiveApprovalMode(sessionId: string): ApprovalMode {
  return (
    getSession(sessionId)?.approvalMode ??
    loadDomoConfig().claude?.approvalMode ??
    'manual'
  )
}

function permissionModeArg(
  mode: ApprovalMode,
): 'default' | 'acceptEdits' | 'passthrough' {
  return mode === 'auto'
    ? 'acceptEdits'
    : mode === 'passthrough'
      ? 'passthrough'
      : 'default'
}

/** Resolve cwd lazily — env.worktreePath may not exist until provisioning. */
function resolveCwd(sessionId: string): string {
  const session = getSession(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const env = getEnv(session.envId)
  if (!env?.worktreePath) {
    throw new Error('env has no worktree yet — provision it first')
  }
  return env.worktreePath
}

function ensureProc(sessionId: string): SessionProc {
  let sp = procs.get(sessionId)
  if (sp) return sp
  const cwd = resolveCwd(sessionId)
  const approvalMode = effectiveApprovalMode(sessionId)
  const resumeId = getSession(sessionId)?.nativeClaudeSessionId ?? undefined
  const proc = spawnClaudeProcess({
    cwd,
    resumeSessionId: resumeId,
    permissionMode: permissionModeArg(approvalMode),
  })
  sp = {
    sessionId,
    cwd,
    proc,
    abortCtl: null,
    steer: null,
    diffs: new Map(),
    queue: [],
    idleTimer: null,
  }
  procs.set(sessionId, sp)

  proc.onExit(() => {
    // Clear all in-process state for this session. Boot-reconcile logic
    // doesn't apply (the rest of Domo is still running); just settle any
    // straggler diffs as rejected for cosmetics.
    if (sp!.idleTimer) clearTimeout(sp!.idleTimer)
    sp!.idleTimer = null
    sp!.abortCtl = null
    sp!.steer = null
    for (const [callId, w] of sp!.diffs) {
      sp!.diffs.delete(callId)
      w.resolve(false)
      const row = getPendingDiff(sessionId, callId)
      if (row && row.status === 'pending') {
        setPendingDiffStatus(sessionId, callId, 'rejected')
        recordEvent(sessionId, 'diff_decision', {
          callId,
          decision: 'reject',
          reason: 'process exited',
        })
      }
    }
    // Drain any queued prompts as failed (they'll respawn anyway next time
    // the user sends).
    for (const q of sp!.queue.splice(0)) {
      q.reject(new Error('claude process exited'))
    }
    procs.delete(sessionId)
    // If the session was 'active' or 'pending-approval' when we exited,
    // reflect that the turn is over.
    const cur = getSession(sessionId)
    if (cur && (cur.status === 'active' || cur.status === 'pending-approval')) {
      setStatus(sessionId, 'waiting')
    }
  })

  return sp
}

/**
 * Drive the next queued prompt on this session's process. Called after a
 * turn ends. Errors are surfaced to the queued promise; the next prompt
 * goes through on its own respawn if the process died.
 */
function drainQueue(sp: SessionProc): void {
  if (sp.queue.length === 0) {
    resetIdleReap(sp)
    return
  }
  const next = sp.queue.shift()!
  const approvalMode = effectiveApprovalMode(sp.sessionId)
  recordEvent(sp.sessionId, 'prompt', { text: next.text })
  runOneTurn({ sp, prompt: next.text, approvalMode })
    .then(() => {
      next.resolve()
    })
    .catch((err) => {
      next.reject(err)
    })
    .finally(() => {
      drainQueue(sp)
    })
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface PromptResult {
  steered: boolean
  uuid?: string
}

export const sessionEngine = {
  /**
   * Deliver a user message. If a turn is live: **steer** (inject as a
   * mid-turn user message; CLI consumes at the next step boundary; durable
   * `steer_sent` carries the same uuid the `--replay-user-messages` echo
   * matches). Else: a fresh turn (new or queued — runs single-flight).
   *
   * Resolves once the message is delivered (steered) or the turn is
   * accepted into the queue / started. The turn's *output* flows through
   * `session_events` + the change bus; callers don't await completion.
   */
  prompt(sessionId: string, text: string): PromptResult {
    const session = getSession(sessionId)
    if (!session) throw new Error('session not found')

    // Live turn → steer.
    const live = procs.get(sessionId)
    if (live && live.steer) {
      const uuid = randomUUID()
      live.steer(text, uuid)
      touchLastEvent(sessionId)
      if (live.idleTimer) clearTimeout(live.idleTimer)
      return { steered: true, uuid }
    }

    // No live turn → spawn / reuse the process and run a fresh turn.
    const sp = ensureProc(sessionId)
    if (sp.idleTimer) clearTimeout(sp.idleTimer)
    sp.idleTimer = null

    // If a turn is in progress *but* `steer` isn't ready yet (pre-`onReady`,
    // or a queued earlier prompt is still draining), queue this one.
    if (sp.abortCtl || sp.queue.length > 0) {
      const queuedAt: QueuedPrompt = {
        text,
        resolve: () => undefined,
        reject: () => undefined,
      }
      sp.queue.push(queuedAt)
      // Record the prompt now so the transcript reflects send order; the
      // turn for it will fire when its predecessor's `result` lands.
      recordEvent(sessionId, 'prompt', { text, queued: true })
      return { steered: false }
    }

    recordEvent(sessionId, 'prompt', { text })
    const approvalMode = effectiveApprovalMode(sessionId)
    runOneTurn({ sp, prompt: text, approvalMode })
      .catch(() => {
        /* recordEvent('error', …) is already emitted in runOneTurn */
      })
      .finally(() => {
        drainQueue(sp)
      })
    return { steered: false }
  },

  /** Abort the in-flight turn (if any). Returns true if a turn was running. */
  abort(sessionId: string): boolean {
    const sp = procs.get(sessionId)
    if (!sp || !sp.abortCtl) {
      // Nothing to kill in-process. If the cached status was 'active',
      // a previous crash left it stale — un-stick.
      const cur = getSession(sessionId)
      if (
        cur &&
        (cur.status === 'active' || cur.status === 'pending-approval')
      ) {
        setStatus(sessionId, 'waiting')
      }
      return false
    }
    sp.abortCtl.abort()
    // The turn's onExit handler records `aborted` + setStatus('waiting').
    return true
  },

  /**
   * Resolve a parked diff. Returns true if a live park was settled (the
   * running turn continues with allow/deny); false if there was nothing
   * to settle — caller updates the durable row directly as a "post-restart
   * cleanup" decision so the card clears.
   */
  diffDecision(
    sessionId: string,
    callId: string,
    decision: 'accept' | 'reject',
  ): { inProcess: boolean } {
    const sp = procs.get(sessionId)
    const w = sp?.diffs.get(callId)
    if (sp && w) {
      sp.diffs.delete(callId)
      w.resolve(decision === 'accept')
      return { inProcess: true }
    }
    // No live park — the parking turn died. Record the decision durably
    // so the card clears; next prompt resumes via `--resume` and may
    // re-propose the edit. Do NOT replay-apply the dead turn's edit (it
    // would race a re-proposal and double-write).
    const row = getPendingDiff(sessionId, callId)
    if (row && row.status === 'pending') {
      setPendingDiffStatus(
        sessionId,
        callId,
        decision === 'accept' ? 'accepted' : 'rejected',
      )
      recordEvent(sessionId, 'diff_decision', {
        callId,
        decision,
        reason: 'post-restart',
      })
    }
    return { inProcess: false }
  },

  /** The before/after for a still-parked agent edit (workspace full diff). */
  getPendingDiffMeta(
    sessionId: string,
    callId: string,
  ): { path: string; before: string; after: string; tabName: string } | null {
    const live = procs.get(sessionId)?.diffs.get(callId)
    if (live) return { ...live.meta }
    const row = getPendingDiff(sessionId, callId)
    if (!row || row.status !== 'pending') return null
    return {
      path: row.path,
      before: row.before,
      after: row.after,
      tabName: row.tabName ?? '',
    }
  },

  /** All `pending_diffs` rows for a session — feeds the chat approval card. */
  listPendingDiffs(sessionId: string): PendingDiffRow[] {
    return listPendingDiffs(sessionId)
  },

  /**
   * Boot reconcile (Decided #7). Runs once at startup before any session
   * is touched. Reflects "the process died, the durable log is intact":
   * stale cached statuses flip to `waiting`, orphan parked diffs reject.
   */
  bootReconcile(): void {
    for (const s of listAllSessions()) {
      const rejected = rejectAllPending(s.id)
      for (const r of rejected) {
        recordEvent(s.id, 'diff_decision', {
          callId: r.callId,
          decision: 'reject',
          reason: 'runtime restarted',
        })
      }
      if (s.status === 'active' || s.status === 'pending-approval') {
        recordEvent(s.id, 'aborted', { reason: 'runtime restarted' })
        setStatus(s.id, 'waiting')
      }
    }
  },

  /** Shut down every live process (server close hook). */
  async stopAll(): Promise<void> {
    const all = [...procs.values()]
    for (const sp of all) {
      sp.proc.kill()
    }
    // Wait briefly for clean exits.
    await Promise.all(
      all.map(
        (sp) =>
          new Promise<void>((res) => {
            sp.proc.onExit(() => res())
          }),
      ),
    )
  },
}
