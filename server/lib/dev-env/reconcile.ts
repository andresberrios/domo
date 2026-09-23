import type { DevEnvironment, DevEnvironmentStatus, EnvironmentLeftover } from '../../../shared/types'
import { listDevEnvironments, pruneRetiredRecords, setEnvironmentLeftovers } from '../repo'
import {
  describeLeftovers,
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
 * environment: a container something else left mounting the volume, a container
 * somebody ran from the image by hand. Before this, every one of those failures
 * was swallowed by an `allowFailure` and a `.catch(() => {})`, retirement
 * reported success, and **nothing ever looked again** — measured, once, as a
 * full checkout left on disk referenced by nothing.
 *
 * What makes it fixable is that a retired environment **keeps its row**, and
 * every name it owns is derived from its id. So the rows are an authoritative
 * list of what should no longer exist, and the leftovers of a failed cleanup
 * are findable by name however much later — a lookup rather than a race against
 * a window, which is what lets the retry be somebody's deliberate second go
 * instead of a timer. `leftovers.ts` holds the attribution rule that keeps that
 * safe.
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
    const owed = remaining.get(environment.id) ?? []
    await setEnvironmentLeftovers(environment.id, owed, health(environment, owed))
  }
  // A row that was only being kept because it still owed something can go now.
  if (outcome.removed.length) await pruneRetiredRecords()
  return { removed: outcome.removed, leftovers: outcome.failed, unattributed }
}

/**
 * What a half-cleaned environment reports as its health.
 *
 * A retirement that leaves gigabytes behind is not a quiet field on a row: it
 * is something wrong that needs a person, so it reads as `error` with the
 * blocker named in `last_error` — the same generic state a failed creation
 * uses, and the one an environment's banner keys on. A successful cleanup puts
 * it back to `stopped`, which is what a retired environment normally is.
 *
 * `status` is health and `retired_at` is lifecycle, and they are independent:
 * retiring cannot wait for Docker to agree (the container has to go first, or
 * the volume can never be removed at all, and by then the sessions can never
 * run again) so the row is retired and *then* found to owe something.
 *
 * Null for a row that is not retired: the wreckage of a failed creation is a
 * detail of that failure, and the creation's own message is the one worth
 * keeping on screen.
 */
function health(
  environment: DevEnvironment,
  owed: EnvironmentLeftover[]
): { status: DevEnvironmentStatus, lastError: string | null } | null {
  if (!environment.retiredAt) return null
  return owed.length
    ? { status: 'error', lastError: describeLeftovers(owed) }
    : { status: 'stopped', lastError: null }
}

/**
 * The reconciliation, and when it runs: **after every retirement, once at
 * boot, and whenever somebody asks for it again.** No timer, deliberately.
 *
 * An escalating retry was the obvious answer and it is the wrong one. What
 * survives one honest attempt is not transient — a container another tool left
 * mounting the volume, an image somebody built a container from, an image that
 * has become the base for another image — and none of those clear on their own.
 * Retrying quietly for hours would hide, for hours, a problem a person or an
 * agent could fix in seconds if only they were told what it was. So a refusal
 * is a **failure with a name in it** (`explainRefusal`), reported on every
 * surface that can retire something, and the retry is theirs to run once they
 * have removed whatever was in the way.
 *
 * The boot pass stays, because it is the one moment where the blocker has very
 * likely gone by itself: the machine restarted, and whatever held the volume is
 * not running any more. It costs nothing on an install with nothing owed —
 * `reconcileEnvironmentResources` returns before asking Docker anything.
 */

let chain: Promise<unknown> = Promise.resolve()
let lastUnreachable: string | null = null
let lastUnattributed: string | null = null

/**
 * A pass, queued behind whatever is already running rather than joined to it.
 *
 * Joining would be cheaper and would answer the wrong question: a retirement
 * that lands while another pass is halfway through would get that pass's
 * report, which was planned from rows read before this environment was
 * retired, and would call a cleanup nobody has checked yet a success.
 */
export async function sweepEnvironmentResources(): Promise<CleanupReport> {
  const next = chain.then(() => pass(), () => pass())
  chain = next.catch(() => {})
  return next
}

async function pass(): Promise<CleanupReport> {
  let report: CleanupReport
  try {
    report = await reconcileEnvironmentResources()
  } catch (error) {
    report = { ...EMPTY, unreachable: error instanceof Error ? error.message : String(error) }
  }
  if (report.unreachable) {
    // Once per stretch of failure: a machine with no daemon would otherwise say
    // the same thing on every retirement for ever.
    if (lastUnreachable !== report.unreachable) {
      console.warn(`[dev-env] could not check for leftover Docker resources: ${report.unreachable}`)
      lastUnreachable = report.unreachable
    }
    return report
  }
  lastUnreachable = null
  for (const removed of report.removed) {
    console.warn(`[dev-env] removed leftover ${describe(removed)} from retired environment ${removed.environmentId}`)
  }
  if (report.unattributed.length && lastUnattributed !== report.unattributed.join(',')) {
    lastUnattributed = report.unattributed.join(',')
    console.warn(
      `[dev-env] ${report.unattributed.join(', ')} look like Domo's and belong to no environment record. `
      + 'Left alone: nothing here can tell them from another install\'s. Remove them by hand if they are yours.'
    )
  }
  for (const left of report.leftovers) {
    console.warn(
      `[dev-env] leftover ${describe(left)} from environment ${left.environmentId} was not removed. ${left.error}`
    )
  }
  return report
}
