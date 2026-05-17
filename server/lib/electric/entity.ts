import type { EntityRegistry } from '@electric-ax/agents-runtime'
import {
  abortInboxSchema,
  creationArgsSchema,
  diffDecisionInboxSchema,
  eventKey,
  eventRowSchema,
  inboxStateRowSchema,
  pendingDiffRowSchema,
  promptInboxSchema,
  sessionMetaRowSchema,
  type EventRow,
  type InboxStateRow,
  type PendingDiffRow,
  type SessionMetaRow,
} from './schemas'
import { CLAUDE_CODE_CLI_ENTITY } from './config'
import { runClaudeTurn, type PermissionDecision } from './claude'
import { updateSession } from '../sessions'
import { expandInWorktree } from '../promptExpand'
import {
  beginTurn,
  endTurn,
  parkDiff,
  registerSteer,
  resolveDiff,
} from './sessionControl'
import type { SessionStatus as DomoSessionStatus } from '../schemas'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Minimal typed view of the agents-runtime `HandlerContext` — exactly the
 * surface this entity uses. The library's `HandlerContext` is generic over
 * state/args/actions in a way that fights standalone helper typing; we cast
 * once at the `registry.define` seam (the runtime provides these members)
 * and keep the rest of the file strongly typed against our own schemas.
 */
interface Coll<T> {
  get(key: string): T | undefined
  readonly toArray: ReadonlyArray<T>
}
interface InboxRow {
  key: string
  from: string
  payload?: unknown
  timestamp: string
  message_type?: string
}
interface EntityCtx {
  args: unknown
  tags: Readonly<Record<string, unknown>>
  setTag(key: string, value: string): Promise<void>
  recordRun(): {
    key: string
    end(opts: { status: 'completed' | 'failed'; finishReason?: string }): void
    attachResponse(text: string): void
  }
  db: {
    collections: {
      sessionMeta: Coll<SessionMetaRow>
      inboxState: Coll<InboxStateRow>
      events: Coll<EventRow>
      pendingDiffs: Coll<PendingDiffRow>
      inbox: Coll<InboxRow>
    }
    actions: {
      sessionMeta_insert(a: { row: SessionMetaRow }): unknown
      sessionMeta_update(a: {
        key: string
        updater: (d: SessionMetaRow) => void
      }): unknown
      inboxState_insert(a: { row: InboxStateRow }): unknown
      inboxState_update(a: {
        key: string
        updater: (d: InboxStateRow) => void
      }): unknown
      events_insert(a: { row: EventRow }): unknown
      pendingDiffs_insert(a: { row: PendingDiffRow }): unknown
      pendingDiffs_update(a: {
        key: string
        updater: (d: PendingDiffRow) => void
      }): unknown
    }
  }
}

/** Map the entity's lifecycle status onto Domo's left-rail vocabulary. */
function domoStatus(s: SessionMetaRow['status']): DomoSessionStatus {
  switch (s) {
    case 'running':
      return 'active'
    case 'pending-approval':
      return 'pending-approval'
    case 'error':
      return 'error'
    default:
      return 'waiting'
  }
}

/**
 * Best-effort mirror of live entity state into Domo's SQLite `sessions`
 * row — the cached `status` + `lastEventAt` the left rail renders and the
 * new-output dot is computed from. The durable stream stays authoritative;
 * this is the fast-first-render cache. The pull-wake runtime is in-process
 * (design Decided #11–14) so the `db()` singleton is available; a failure
 * here (DB gone, row deleted mid-turn) must never break the turn.
 */
function mirrorToDb(
  ctx: EntityCtx,
  patch: { status?: SessionMetaRow['status']; lastEventAt?: number },
): void {
  const sessionId = ctx.db.collections.sessionMeta.get('current')?.sessionId
  if (!sessionId) return
  try {
    updateSession(sessionId, {
      ...(patch.status ? { status: domoStatus(patch.status) } : {}),
      ...(patch.lastEventAt ? { lastEventAt: patch.lastEventAt } : {}),
    })
  } catch {
    /* DB unavailable / row gone — cached status is non-authoritative */
  }
}

function appendEvent(
  ctx: EntityCtx,
  type: string,
  payload: Record<string, unknown>,
  callId?: string,
): void {
  const ts = Date.now()
  const row: EventRow = {
    key: eventKey(ts, type, JSON.stringify(payload) + (callId ?? '')),
    ts,
    type,
    ...(callId !== undefined ? { callId } : {}),
    payload,
  }
  if (ctx.db.collections.events.get(row.key) !== undefined) return
  ctx.db.actions.events_insert({ row })
  // Any mirrored envelope is "activity" → powers the per-device dot.
  mirrorToDb(ctx, { lastEventAt: ts })
}

/** Worktree-relative when the edit is inside cwd (it is — `--add-dir
 *  <cwd>`); absolute otherwise. Keeps `pendingDiffs.path` UI/link-friendly. */
function relWorktree(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) ? rel : abs
}

/** File-modifying tools whose permission prompt becomes a diff card. */
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Update',
])

/**
 * Reconstruct the proposed file change from a tool's permission-request
 * input, for the durable `pendingDiffs` UI (`before`/`after`). The CLI
 * itself applies the edit on allow — this is display-only, so a best-effort
 * reconstruction is fine (the agent's tool_result still shows the truth).
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

/**
 * Run one Claude turn for `prompt`: spawn host-side `claude`
 * (stream-json in/out), mirror every envelope into the durable `events`
 * stream as it arrives, capture Claude's `session_id` on the first turn
 * (`--resume` thereafter).
 *
 * **Diff approval (official-extension `--permission-prompt-tool stdio`).**
 * The CLI asks before each tool. Non-edit tools are auto-allowed (keeps
 * Bash/Read frictionless, like the old `acceptEdits` did). Edit-family
 * tools become a durable `pendingDiffs` row + `pending_diff` event, flip
 * status to `pending-approval`, and **park** on an in-process promise
 * (see `sessionControl` for why the decision can't come back as a durable
 * wake). `sessions.diffDecision` resolves it; we record the outcome
 * durably and answer the CLI `allow` (the CLI then performs the edit
 * itself — Domo does not write the file in the live path) or `deny`. The
 * request id doubles as the `pendingDiffs` callId so a CLI-side cancel
 * maps straight back. Abort/teardown SIGTERMs the child and settles
 * parked diffs as rejected.
 */
async function executeClaudeTurn(
  ctx: EntityCtx,
  prompt: string,
  meta: SessionMetaRow,
): Promise<void> {
  const sessionId = meta.sessionId
  const ac = new AbortController()
  beginTurn(sessionId, () => ac.abort())

  const onPermissionRequest = async (req: {
    toolName: string
    input: Record<string, unknown>
    toolUseId: string
    requestId: string
  }): Promise<PermissionDecision> => {
    if (!EDIT_TOOLS.has(req.toolName)) {
      return { behavior: 'allow', updatedInput: req.input }
    }
    const callId = req.requestId
    const { path, before, after } = await proposeEdit(
      meta.cwd,
      req.toolName,
      req.input,
    )
    ctx.db.actions.pendingDiffs_insert({
      row: {
        callId,
        path,
        before,
        after,
        tabName: `${req.toolName} ${path}`,
        status: 'pending',
        createdTs: Date.now(),
      },
    })
    appendEvent(ctx, 'pending_diff', { callId, path }, callId)
    setStatus(ctx, { status: 'pending-approval' })

    const accepted = await parkDiff(sessionId, callId, {
      path,
      before,
      after,
      tabName: `${req.toolName} ${path}`,
    })

    ctx.db.actions.pendingDiffs_update({
      key: callId,
      updater: (d: PendingDiffRow) => {
        d.status = accepted ? 'accepted' : 'rejected'
      },
    })
    appendEvent(
      ctx,
      'diff_decision',
      { decision: accepted ? 'accept' : 'reject' },
      callId,
    )
    setStatus(ctx, { status: 'running' })

    // On allow the CLI applies the edit itself; Domo never writes the file
    // in the live path (only the post-restart durable fallback does).
    return accepted
      ? { behavior: 'allow', updatedInput: req.input }
      : { behavior: 'deny', message: 'Rejected by the user' }
  }

  const onPermissionCancel = (requestId: string): void => {
    // The CLI withdrew the request — settle the park so the card clears.
    if (!resolveDiff(sessionId, requestId, false)) return
    const row = ctx.db.collections.pendingDiffs.get(requestId)
    if (row && row.status === 'pending') {
      ctx.db.actions.pendingDiffs_update({
        key: requestId,
        updater: (d: PendingDiffRow) => {
          d.status = 'rejected'
        },
      })
    }
  }

  try {
    // Resolve custom slash commands + @-mentions now (the CLI doesn't in
    // stream-json mode); the inbox/transcript keeps the raw user text.
    const resolved = await expandInWorktree(meta.cwd, prompt)
    await runClaudeTurn({
      cwd: meta.cwd,
      prompt: resolved,
      resumeSessionId: meta.nativeSessionId,
      signal: ac.signal,
      onPermissionRequest,
      onPermissionCancel,
      // Mid-turn steering (Decided #18): record a durable `steer_sent`
      // event from inside the live handler (send-ordered, survives
      // reload), then inject into the child's stdin. The CLI's
      // `isReplay` echo (mirrored via onEvent) is matched by uuid to
      // flip the bubble queued→delivered.
      onReady: (steerWrite) => {
        registerSteer(sessionId, (text, uuid) => {
          appendEvent(ctx, 'steer_sent', { text, uuid })
          steerWrite(text, uuid)
        })
      },
      onEvent: (type, envelope) => appendEvent(ctx, type, envelope),
      onSessionId: (id) => {
        if (meta.nativeSessionId === id) return
        ctx.db.actions.sessionMeta_update({
          key: 'current',
          updater: (d: SessionMetaRow) => {
            d.nativeSessionId = id
          },
        })
      },
    })
    if (ac.signal.aborted) appendEvent(ctx, 'aborted', {})
  } finally {
    endTurn(sessionId)
  }
}

function seedStateIfNeeded(ctx: EntityCtx): {
  meta: SessionMetaRow
  inboxState: InboxStateRow
} {
  // `ctx.firstWake` is unreliable for entities that never write a manifest;
  // guard on read state instead (per electric-source define-entity review).
  let meta = ctx.db.collections.sessionMeta.get('current')
  if (!meta) {
    const args = creationArgsSchema.parse(ctx.args)
    meta = {
      key: 'current',
      sessionId: args.sessionId,
      envId: args.envId,
      coastInstance: args.coastInstance,
      cwd: args.cwd,
      status: 'idle',
    }
    ctx.db.actions.sessionMeta_insert({ row: meta })
  }
  let inboxState = ctx.db.collections.inboxState.get('current')
  if (!inboxState) {
    inboxState = { key: 'current' }
    ctx.db.actions.inboxState_insert({ row: inboxState })
  }
  return { meta, inboxState }
}

function setStatus(ctx: EntityCtx, patch: Partial<SessionMetaRow>): void {
  ctx.db.actions.sessionMeta_update({
    key: 'current',
    updater: (d: SessionMetaRow) => {
      Object.assign(d, patch)
      if (patch.error === undefined && 'error' in patch) delete d.error
    },
  })
  if (patch.status) mirrorToDb(ctx, { status: patch.status })
}

function advanceInbox(ctx: EntityCtx, key: string): void {
  ctx.db.actions.inboxState_update({
    key: 'current',
    updater: (d: InboxStateRow) => {
      d.lastProcessedInboxKey = key
    },
  })
}

/**
 * A `pending` pendingDiffs row seen at handler entry is **orphaned**: the
 * pull-wake runner is single-flight, so a genuinely-live park only ever
 * exists *inside the currently-executing* handler invocation (it inserts
 * the row *after* this runs in that same invocation). Any pending row a
 * fresh invocation sees therefore belongs to a turn that died (server
 * restart / crash). Auto-reject it so the chat card clears and the
 * session un-sticks; the interrupted prompt (its inbox key was never
 * advanced) re-runs and re-proposes a fresh, actionable diff — that's the
 * "review & continue after a restart" path. (Resolving the in-process map
 * too is a no-op here but harmless.)
 */
function reconcileStalePendingDiffs(ctx: EntityCtx, meta: SessionMetaRow): void {
  let any = false
  for (const d of ctx.db.collections.pendingDiffs.toArray) {
    if (d.status !== 'pending') continue
    any = true
    resolveDiff(meta.sessionId, d.callId, false)
    ctx.db.actions.pendingDiffs_update({
      key: d.callId,
      updater: (r: PendingDiffRow) => {
        r.status = 'rejected'
      },
    })
    appendEvent(
      ctx,
      'diff_decision',
      { decision: 'reject', reason: 'runtime restarted' },
      d.callId,
    )
  }
  if (any && meta.status === 'pending-approval') {
    setStatus(ctx, { status: 'idle', currentPromptInboxKey: undefined })
  }
}

async function runHandler(ctx: EntityCtx): Promise<void> {
  const { meta, inboxState } = seedStateIfNeeded(ctx)
  reconcileStalePendingDiffs(ctx, meta)

  const rows = ctx.db.collections.inbox.toArray
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const lastKey = inboxState.lastProcessedInboxKey ?? ''
  const pending = rows.filter((m) => m.key > lastKey)

  if (pending.length === 0) {
    // `pending-approval` is included so a session whose runtime restarted
    // mid-park (the turn is dead, nothing left to decide) doesn't stay
    // stuck — a fresh wake with an empty inbox reconciles it to idle.
    // Safe under the single-flight runner: a genuinely-blocked turn IS the
    // running handler, so no *other* invocation reaches here meanwhile.
    if (
      meta.status === 'running' ||
      meta.status === 'error' ||
      meta.status === 'pending-approval'
    ) {
      setStatus(ctx, { status: 'idle', currentPromptInboxKey: undefined })
    }
    return
  }

  let runningMeta = meta
  for (const msg of pending) {
    const type = msg.message_type

    if (type === 'abort' && abortInboxSchema.safeParse(msg.payload).success) {
      // Durable fallback only — `sessions.abort` kills the child in-process
      // (single-flight runner can't deliver this mid-turn). Reaching here
      // means no live turn (queued, or runtime restarted). Stale pending
      // diffs were already settled by reconcileStalePendingDiffs at the
      // top of this invocation; just record + un-stick.
      appendEvent(ctx, 'aborted', {})
      setStatus(ctx, { status: 'idle', currentPromptInboxKey: undefined })
      advanceInbox(ctx, msg.key)
      continue
    }

    if (type === 'diff_decision') {
      // Idempotent + effectively a no-op. The live decision is delivered
      // in-process (`sessions.diffDecision` → `resolveDiff` → the running
      // turn records it durably). The durable inbox copy only arrives when
      // there was no in-process park (post-restart); by the time we get
      // here `reconcileStalePendingDiffs` has already rejected that
      // orphaned row and the interrupted prompt re-runs to re-propose a
      // fresh, actionable diff — so there is nothing to apply here. (We
      // deliberately do NOT replay-apply a dead turn's edit: it would race
      // the re-run and double-write.)
      advanceInbox(ctx, msg.key)
      continue
    }

    // Default: treat as a prompt (explicit `prompt` type, or a bare
    // `{ text }` send from a generic input with no message_type).
    const parsed = promptInboxSchema.safeParse(msg.payload)
    if (!parsed.success) {
      advanceInbox(ctx, msg.key)
      continue
    }
    const prompt = parsed.data.text

    if (typeof ctx.tags.title !== 'string' || ctx.tags.title.length === 0) {
      void ctx.setTag('title', prompt.slice(0, 80))
    }

    setStatus(ctx, {
      status: 'running',
      currentPromptInboxKey: msg.key,
      error: undefined,
    })
    const run = ctx.recordRun()
    try {
      await executeClaudeTurn(ctx, prompt, runningMeta)
      run.end({ status: 'completed' })
      setStatus(ctx, { status: 'idle', currentPromptInboxKey: undefined })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      run.end({ status: 'failed', finishReason: 'error' })
      appendEvent(ctx, 'error', { message })
      setStatus(ctx, { status: 'error', error: message })
    }
    advanceInbox(ctx, msg.key)
    runningMeta = ctx.db.collections.sessionMeta.get('current') ?? runningMeta
  }
}

export function registerClaudeCodeCli(registry: EntityRegistry): void {
  registry.define(CLAUDE_CODE_CLI_ENTITY, {
    description:
      'A Claude Code CLI session (host-side spawn), mirrored into a durable stream. ' +
      'Prompts arrive via the `prompt` inbox; Edit/Write route through the IDE ' +
      'bridge `openDiff` for user approval (diff_decision inbox).',
    creationSchema: creationArgsSchema,
    inboxSchemas: {
      prompt: promptInboxSchema,
      diff_decision: diffDecisionInboxSchema,
      abort: abortInboxSchema,
    },
    state: {
      sessionMeta: { schema: sessionMetaRowSchema, primaryKey: 'key' },
      inboxState: { schema: inboxStateRowSchema, primaryKey: 'key' },
      events: { schema: eventRowSchema, primaryKey: 'key' },
      pendingDiffs: { schema: pendingDiffRowSchema, primaryKey: 'callId' },
    },
    // Params are contextually typed by the library's EntityDefinition;
    // we narrow to our own EntityCtx at this single seam.
    handler: (rawCtx) => runHandler(rawCtx as unknown as EntityCtx),
  })
}
