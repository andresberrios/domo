import type { EnvironmentLeftover } from '../../../shared/types'
import { listDevEnvironments, pruneRetiredRecords, setEnvironmentLeftovers } from '../repo'
import {
  observeEnvironmentResources,
  planLeftoverRemoval,
  removeLeftovers,
  unattributedResources,
  type Leftover
} from './leftovers'

/**
 * Reconcile what Docker has against what the rows say should be left.
 *
 * A cleanup step can fail for reasons that have nothing to do with the
 * environment and everything to do with the minute it ran in: a volume another
 * container still has mounted, a daemon under load, a full disk. Before this,
 * every one of those failures was swallowed by an `allowFailure` and a
 * `.catch(() => {})`, retirement reported success, and **nothing ever looked
 * again** — measured, once, as a full checkout left on disk referenced by
 * nothing.
 *
 * What makes it fixable rather than merely retryable is that a retired
 * environment **keeps its row**, and every name it owns is derived from its id.
 * So the rows are an authoritative list of what should no longer exist, the
 * leftovers of a failed cleanup are findable by name however much later, and a
 * retry is not a race against a window but a lookup. `leftovers.ts` holds the
 * attribution rule that keeps that safe.
 *
 * The row is also the record: whatever is still there after a pass is written
 * to `dev_environments.leftovers`, which is what stops `pruneRetiredRecords`
 * dropping the row that is the only way back to it, and what a retirement
 * reports to whoever asked for it instead of claiming success.
 */

export interface CleanupReport {
  removed: Leftover[]
  /** Claimed, still there, and not removable this time. Each with why. */
  leftovers: Array<Leftover & { error: string }>
  /**
   * Prefixed resources no row accounts for. Never removed — see
   * `unattributedResources` — and named so a person can decide.
   */
  unattributed: string[]
  /** Set when Docker could not be asked at all: nothing was removed and nothing was recorded. */
  unreachable?: string
}

const EMPTY: CleanupReport = { removed: [], leftovers: [], unattributed: [] }

/** How long the janitor waits before looking again while anything is still owed. */
const RETRY_MIN_MS = 60_000
const RETRY_MAX_MS = 30 * 60_000

function describe(leftover: Leftover): string {
  return `${leftover.kind} ${leftover.name}`
}

/**
 * One pass: ask Docker what it has, remove what a row claims and it still has,
 * and write down whatever survived that.
 *
 * Every environment with a claim gets its `leftovers` rewritten from this
 * pass's observation, which is also how the column clears itself — a volume
 * somebody removed by hand is simply not observed any more.
 */
export async function reconcileEnvironmentResources(): Promise<CleanupReport> {
  const environments = await listDevEnvironments(undefined, true)
  // No environment has ever existed, so nothing on this daemon can be Domo's.
  // Worth the early return: an install that does not use development
  // environments at all must not log a Docker error every half hour.
  if (!environments.length) return EMPTY
  const claimants = environments.filter(
    environment => environment.retiredAt || environment.leftovers.length
  )

  let present
  try {
    present = await observeEnvironmentResources()
  } catch (error) {
    return { ...EMPTY, unreachable: error instanceof Error ? error.message : String(error) }
  }
  const unattributed = unattributedResources({ environments, present })

  const outcome = await removeLeftovers(planLeftoverRemoval({ environments: claimants, present }))
  const remaining = new Map<string, EnvironmentLeftover[]>()
  for (const failure of outcome.failed) {
    const list = remaining.get(failure.environmentId) ?? []
    list.push({ kind: failure.kind, name: failure.name, error: failure.error })
    remaining.set(failure.environmentId, list)
  }
  for (const environment of claimants) {
    await setEnvironmentLeftovers(environment.id, remaining.get(environment.id) ?? [])
  }
  // A row that was only being kept because it still owed something can go now.
  if (outcome.removed.length) await pruneRetiredRecords()
  return { removed: outcome.removed, leftovers: outcome.failed, unattributed }
}

/**
 * The reconciliation, and when it runs.
 *
 * Three moments, and each covers a gap the others cannot. **After every
 * retirement**, because that is when leftovers are made and when the rows to
 * compare against are freshest. **At boot**, because a retirement that failed
 * is otherwise waiting on the next one, and a Domo that is restarted is a Domo
 * whose host has very likely just changed. And **on a retry while anything is
 * still owed**, because the reason a removal fails is usually temporary and
 * outlives neither the hour nor the process: the volume that was left behind
 * was free again an hour later, with nothing running that would look.
 *
 * The retry is armed by state, not by a clock — with nothing owed there is no
 * timer at all, so an install that never retires anything never sweeps and
 * never asks Docker anything.
 */
class EnvironmentJanitor {
  private timer: NodeJS.Timeout | null = null
  private delay = RETRY_MIN_MS
  private chain: Promise<unknown> = Promise.resolve()
  private lastUnreachable: string | null = null
  private lastUnattributed: string | null = null

  start(): void {
    void this.sweep()
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.delay = RETRY_MIN_MS
  }

  /**
   * A pass, queued behind whatever is already running rather than joined to it.
   *
   * Joining would be cheaper and would answer the wrong question: a retirement
   * that lands while a timer's pass is halfway through would get that pass's
   * report, which was planned from rows read before this environment was
   * retired, and would call a cleanup nobody has checked yet a success.
   */
  async sweep(): Promise<CleanupReport> {
    const next = this.chain.then(() => this.pass(), () => this.pass())
    this.chain = next.catch(() => {})
    return next
  }

  private async pass(): Promise<CleanupReport> {
    let report: CleanupReport
    try {
      report = await reconcileEnvironmentResources()
    } catch (error) {
      report = { ...EMPTY, unreachable: error instanceof Error ? error.message : String(error) }
    }
    if (report.unreachable) {
      // Once per stretch of failure: a machine with no daemon would otherwise
      // say the same thing every half hour for ever.
      if (this.lastUnreachable !== report.unreachable) {
        console.warn(`[dev-env] could not check for leftover Docker resources: ${report.unreachable}`)
        this.lastUnreachable = report.unreachable
      }
    } else {
      this.lastUnreachable = null
      for (const removed of report.removed) {
        console.warn(`[dev-env] removed leftover ${describe(removed)} from retired environment ${removed.environmentId}`)
      }
      if (report.unattributed.length && this.lastUnattributed !== report.unattributed.join(',')) {
        this.lastUnattributed = report.unattributed.join(',')
        console.warn(
          `[dev-env] ${report.unattributed.join(', ')} look like Domo's and belong to no environment record. `
          + 'Left alone: nothing here can tell them from another install\'s. Remove them by hand if they are yours.'
        )
      }
      for (const left of report.leftovers) {
        console.warn(
          `[dev-env] leftover ${describe(left)} from environment ${left.environmentId} could not be removed `
          + `and will be retried: ${left.error}`
        )
      }
    }
    this.rearm(Boolean(report.unreachable) || report.leftovers.length > 0)
    return report
  }

  private rearm(pending: boolean): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!pending) {
      this.delay = RETRY_MIN_MS
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.sweep()
    }, this.delay)
    this.timer.unref?.()
    this.delay = Math.min(this.delay * 2, RETRY_MAX_MS)
  }
}

export const environmentJanitor = new EnvironmentJanitor()
