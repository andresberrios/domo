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
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
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
  readChatSince,
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
  /** Host worktree path. Tool calls' file paths translate against this. */
  cwd: string
  /** When the session runs inside a container (step 3b+), the workspace
   * folder claude sees from inside (`/workspaces/<basename>` by default).
   * Null = host-side spawn (legacy / pre-step-3b envs). */
  containerWorkspace: string | null
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
 * Translate a path claude emitted (which may be container-side when
 * the session runs inside a devcontainer) to a host filesystem path.
 * For host-side spawns (no `containerWorkspace`), this is identity.
 * For container spawns, the convention is
 *   `<containerWorkspace>/<rel>` ↔ `<hostCwd>/<rel>`.
 */
function toHostPath(sp: { cwd: string; containerWorkspace: string | null }, abs: string): string {
  if (!sp.containerWorkspace) return abs
  const prefix = sp.containerWorkspace.endsWith('/') ? sp.containerWorkspace : sp.containerWorkspace + '/'
  if (abs === sp.containerWorkspace) return sp.cwd
  if (abs.startsWith(prefix)) return resolve(sp.cwd, abs.slice(prefix.length))
  return abs
}

/**
 * Reconstruct the proposed file change from a tool's permission-request
 * input, for the durable `pending_diffs` UI. The CLI itself applies the
 * edit on allow — this is display-only. Path translation handles
 * in-container spawns where the CLI emits `/workspaces/<envName>/foo.js`
 * but the file lives on the host at `<env.worktreePath>/foo.js`.
 */
async function proposeEdit(
  sp: { cwd: string; containerWorkspace: string | null },
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ path: string; before: string; after: string }> {
  const rawPath = String(
    input.file_path ?? input.notebook_path ?? input.path ?? '',
  )
  const absMaybeContainer = isAbsolute(rawPath) ? rawPath : resolve(sp.cwd, rawPath)
  const abs = toHostPath(sp, absMaybeContainer)
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
  return { path: relWorktree(sp.cwd, abs), before, after }
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
      sp,
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

/**
 * Resolve where to spawn `claude` for a session. Returns the host
 * worktree path (for path translation against absolute tool-call paths
 * the CLI emits) plus the container id when the env has one — when
 * container id is set, the spawn moves into `docker exec` (step 3b
 * behavior); otherwise it falls back to host-side (legacy envs).
 *
 * Synchronous: we read the stored `containerId` directly off the env
 * row, no `docker inspect` round-trip per prompt. If the container has
 * been recreated under us, the next `docker exec` will fail and the
 * engine will report `error` for the turn, prompting the user to
 * re-up. Boot reconcile (`plugins/sessionEngine.ts`) is the place that
 * rebinds stale ids via the `domo.envId` label.
 */
function resolveSessionContext(sessionId: string): {
  cwd: string
  containerId: string | null
} {
  const session = getSession(sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const env = getEnv(session.envId)
  if (!env?.worktreePath) {
    throw new Error('env has no worktree yet — provision it first')
  }
  return { cwd: env.worktreePath, containerId: env.containerId }
}

function ensureProc(sessionId: string): SessionProc {
  let sp = procs.get(sessionId)
  if (sp) return sp
  const ctx = resolveSessionContext(sessionId)
  const approvalMode = effectiveApprovalMode(sessionId)
  const resumeId = getSession(sessionId)?.nativeClaudeSessionId ?? undefined
  const containerWorkspace = ctx.containerId ? `/workspaces/${basename(ctx.cwd)}` : null
  const proc = spawnClaudeProcess({
    cwd: ctx.cwd,
    containerId: ctx.containerId ?? undefined,
    containerCwd: containerWorkspace ?? undefined,
    resumeSessionId: resumeId,
    permissionMode: permissionModeArg(approvalMode),
  })
  sp = {
    sessionId,
    cwd: ctx.cwd,
    containerWorkspace,
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

/** Author info for prompt / chat events. Identity is trusted in-process
 * — the procedure layer reads it from `requireActiveUser(event)`. */
export interface Author {
  userId: string
  userName: string
}

/**
 * Build the synthesized prompt body for a fresh turn (no steer) by
 * folding any un-consumed `chat` events newer than the session's
 * `lastChatConsumedSeq` into the foreground. Returns `text` unchanged
 * when there's no backlog. Advances `lastChatConsumedSeq` to the max
 * consumed seq so the same chats don't fold again on the next turn.
 */
function foldChatBacklog(sessionId: string, text: string): string {
  const session = getSession(sessionId)
  if (!session) return text
  const backlog = readChatSince(sessionId, session.lastChatConsumedSeq)
  if (backlog.length === 0) return text
  const lines = backlog
    .map((row) => {
      const author = (row.payload?.author ?? null) as Author | null
      const t = String(row.payload?.text ?? '').trim()
      if (!t) return null
      const who = author?.userName?.trim() || author?.userId || 'someone'
      return `[${who} said: ${t}]`
    })
    .filter((s): s is string => s != null)
  if (lines.length === 0) return text
  const maxSeq = backlog[backlog.length - 1]!.seq
  updateSession(sessionId, { lastChatConsumedSeq: maxSeq })
  return `${lines.join('\n')}\n\n${text}`
}

/** A bare `@agent` mention or an explicit `trigger: true` runs a turn;
 * otherwise the chat is recorded and the agent stays silent. v1: any
 * mention of `@agent` (case-insensitive, word-boundary'd) counts. */
function chatHasTrigger(text: string): boolean {
  return /(^|[^\w])@agent(\b|$)/i.test(text)
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
  prompt(sessionId: string, text: string, author?: Author): PromptResult {
    const session = getSession(sessionId)
    if (!session) throw new Error('session not found')

    // Live turn → steer.
    const live = procs.get(sessionId)
    if (live && live.steer) {
      const uuid = randomUUID()
      live.steer(text, uuid)
      // Author goes on the durable `steer_sent` event via the existing
      // turn handler; we still record the steer prompt body here.
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
      recordEvent(sessionId, 'prompt', { text, queued: true, author: author ?? null })
      return { steered: false }
    }

    // Fold any un-consumed `chat` backlog into the synthesized prompt
    // (step 5 group-chat collab). The durable `prompt` event still
    // records the raw user text — folding only changes what the CLI
    // sees, not the transcript.
    const folded = foldChatBacklog(sessionId, text)
    recordEvent(sessionId, 'prompt', { text, author: author ?? null })
    const approvalMode = effectiveApprovalMode(sessionId)
    runOneTurn({ sp, prompt: folded, approvalMode })
      .catch(() => {
        /* recordEvent('error', …) is already emitted in runOneTurn */
      })
      .finally(() => {
        drainQueue(sp)
      })
    return { steered: false }
  },

  /**
   * Append a `chat` event without triggering a turn — the step 5
   * collab path. If the text contains `@agent`, OR the caller passes
   * `trigger: true`, we ALSO kick off a turn (which folds the just-
   * recorded chat into its prompt body). Returns whether a turn was
   * triggered.
   */
  chat(sessionId: string, text: string, author: Author, opts?: { trigger?: boolean }): { triggered: boolean } {
    const session = getSession(sessionId)
    if (!session) throw new Error('session not found')
    recordEvent(sessionId, 'chat', { text, author })
    const triggered = opts?.trigger === true || chatHasTrigger(text)
    if (triggered) {
      // Trigger via the prompt path so steer-vs-fresh-turn / queue
      // semantics are identical to an explicit prompt. The just-recorded
      // chat will fold into the synthesized prompt because its seq is
      // higher than the session's lastChatConsumedSeq.
      this.prompt(sessionId, text, author)
    }
    return { triggered }
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
