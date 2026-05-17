/**
 * In-process per-session control channel for the diff-approval round-trip
 * and turn abort (Phase 3, step 11).
 *
 * **Why in-process and not the durable inbox.** The pull-wake runner is
 * single-flight per entity: it claims a wake, runs `handler(ctx, wake)`,
 * `await drainWakes()`, then reads the next wake. A `prompt` turn that is
 * blocked inside the IDE bridge's `openDiff` (waiting for the user) is
 * *still inside its handler invocation*, so the runner never even claims a
 * later `diff_decision` / `abort` wake — that would deadlock. The runtime
 * is in-process (design Decided #11–14), so `sessions.diffDecision` /
 * `sessions.abort` resolve the parked promise / kill the `claude` child
 * directly through this registry, in the same Node process the handler
 * runs in. The entity still records the outcome durably (pendingDiffs row
 * + `diff_decision` event) from within that live handler so a reconnecting
 * browser replays the result.
 *
 * Process-local by design. A runtime restart loses parked promises — but
 * the `claude` child is a child of that process too, so the whole turn is
 * already dead; the stale `pending` pendingDiffs row is cosmetic until the
 * next turn. (Dev HMR can reset this module; not a concern mid-turn.)
 */
interface ParkedDiff {
  resolve: (accepted: boolean) => void
  path: string
  before: string
  after: string
  tabName: string
}

interface SessionControl {
  diffs: Map<string, ParkedDiff>
  onAbort?: () => void
}

const sessions = new Map<string, SessionControl>()

function ctl(sessionId: string): SessionControl {
  let c = sessions.get(sessionId)
  if (!c) {
    c = { diffs: new Map() }
    sessions.set(sessionId, c)
  }
  return c
}

/** Register the in-flight turn's abort hook (kills the `claude` child). */
export function beginTurn(sessionId: string, onAbort: () => void): void {
  ctl(sessionId).onAbort = onAbort
}

/** Turn finished/failed: settle any still-parked diffs as rejected. */
export function endTurn(sessionId: string): void {
  const c = sessions.get(sessionId)
  if (!c) return
  for (const w of c.diffs.values()) w.resolve(false)
  c.diffs.clear()
  c.onAbort = undefined
}

/**
 * Park an `openDiff` until the user decides. Resolves `true` (accept →
 * `FILE_SAVED`) / `false` (reject → `DIFF_REJECTED`). The before/after are
 * kept here too so `sessions.pendingDiff` can serve the workspace
 * full-diff view without re-reading the durable stream server-side.
 */
export function parkDiff(
  sessionId: string,
  callId: string,
  meta: { path: string; before: string; after: string; tabName: string },
): Promise<boolean> {
  const c = ctl(sessionId)
  return new Promise<boolean>((resolve) => {
    c.diffs.set(callId, { resolve, ...meta })
  })
}

/** Resolve a parked diff; returns false if nothing was parked under it. */
export function resolveDiff(
  sessionId: string,
  callId: string,
  accepted: boolean,
): boolean {
  const c = sessions.get(sessionId)
  const w = c?.diffs.get(callId)
  if (!c || !w) return false
  c.diffs.delete(callId)
  w.resolve(accepted)
  return true
}

export function getParkedDiff(
  sessionId: string,
  callId: string,
): { path: string; before: string; after: string; tabName: string } | null {
  const w = sessions.get(sessionId)?.diffs.get(callId)
  return w
    ? { path: w.path, before: w.before, after: w.after, tabName: w.tabName }
    : null
}

/**
 * Abort the in-flight turn: kill the `claude` child and settle parked
 * diffs as rejected. Returns false if no turn is running in this process
 * (caller may then fall back to the durable inbox `abort`).
 */
export function abortSession(sessionId: string): boolean {
  const c = sessions.get(sessionId)
  if (!c) return false
  for (const w of c.diffs.values()) w.resolve(false)
  c.diffs.clear()
  if (!c.onAbort) return false
  c.onAbort()
  return true
}
