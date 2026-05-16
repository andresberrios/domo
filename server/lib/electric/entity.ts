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
import { runClaudeTurn } from './claude'
import { createIdeBridge } from './bridge'
import { updateSession } from '../sessions'
import { expandInWorktree } from '../promptExpand'
import type { SessionStatus as DomoSessionStatus } from '../schemas'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

/**
 * Run one Claude turn for `prompt`: boot the per-session IDE bridge, spawn
 * host-side `claude` (stream-json in/out) pointed at it, mirror every
 * envelope into the durable `events` stream as it arrives, and capture
 * Claude's `session_id` on the first turn so later turns `--resume` it.
 *
 * `openDiff` (step 8c) is wired here with an interim resolver: persist the
 * agent's edit (the IDE-on-accept writes the file and returns FILE_SAVED —
 * the exact semantics the CLI expects) and log it. Step 11 swaps this for
 * the durable park → `pendingDiffs` → inbox `diff_decision` → resolve
 * round-trip so the user actually approves before the write lands.
 */
async function executeClaudeTurn(
  ctx: EntityCtx,
  prompt: string,
  meta: SessionMetaRow,
): Promise<void> {
  const bridge = await createIdeBridge({
    cwd: meta.cwd,
    onOpenDiff: async (req) => {
      await mkdir(dirname(req.newFilePath), { recursive: true })
      await writeFile(req.newFilePath, req.newFileContents)
      appendEvent(ctx, 'openDiff', {
        path: req.newFilePath,
        tabName: req.tabName,
      })
      return true
    },
  })
  ctx.db.actions.sessionMeta_update({
    key: 'current',
    updater: (d: SessionMetaRow) => {
      d.bridgePort = bridge.port
    },
  })
  try {
    // Resolve custom slash commands + @-mentions now (the CLI doesn't in
    // stream-json mode); the inbox/transcript keeps the raw user text.
    const resolved = await expandInWorktree(meta.cwd, prompt)
    await runClaudeTurn({
      cwd: meta.cwd,
      prompt: resolved,
      resumeSessionId: meta.nativeSessionId,
      bridgePort: bridge.port,
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
  } finally {
    await bridge.close().catch(() => {})
    ctx.db.actions.sessionMeta_update({
      key: 'current',
      updater: (d: SessionMetaRow) => {
        delete d.bridgePort
      },
    })
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

async function runHandler(ctx: EntityCtx): Promise<void> {
  const { meta, inboxState } = seedStateIfNeeded(ctx)

  const rows = ctx.db.collections.inbox.toArray
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const lastKey = inboxState.lastProcessedInboxKey ?? ''
  const pending = rows.filter((m) => m.key > lastKey)

  if (pending.length === 0) {
    if (meta.status === 'running' || meta.status === 'error') {
      setStatus(ctx, { status: 'idle', currentPromptInboxKey: undefined })
    }
    return
  }

  let runningMeta = meta
  for (const msg of pending) {
    const type = msg.message_type

    if (type === 'abort' && abortInboxSchema.safeParse(msg.payload).success) {
      // Full abort wiring (kill the in-flight claude child + reject parked
      // openDiff) lands with step 8b/11. Record + advance for now.
      appendEvent(ctx, 'aborted', {})
      setStatus(ctx, { status: 'idle', currentPromptInboxKey: undefined })
      advanceInbox(ctx, msg.key)
      continue
    }

    if (type === 'diff_decision') {
      const parsed = diffDecisionInboxSchema.safeParse(msg.payload)
      if (parsed.success) {
        // Resolving the parked IDE-bridge openDiff WS call lands with
        // step 11; record the decision durably now.
        const existing = ctx.db.collections.pendingDiffs.get(
          parsed.data.callId,
        )
        if (existing) {
          ctx.db.actions.pendingDiffs_update({
            key: parsed.data.callId,
            updater: (d: PendingDiffRow) => {
              d.status =
                parsed.data.decision === 'accept' ? 'accepted' : 'rejected'
            },
          })
        }
        appendEvent(
          ctx,
          'diff_decision',
          { decision: parsed.data.decision },
          parsed.data.callId,
        )
      }
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
