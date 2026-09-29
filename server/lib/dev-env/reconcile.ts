import type { DevEnvironment, DevEnvironmentStatus, EnvironmentLeftover, Project } from '../../../shared/types'
import { listDevEnvironments, listProjects, markEnvironmentCleaned, setEnvironmentLeftovers } from '../repo'
import { CACHES_ROOT, PNPM_PROJECTS_SWEEP_SCRIPT, pnpmProjectDir, sharedCacheVolumeName } from './caches'
import { run } from './docker'
import { deleteMergedBranch, hostWorktreeExists, hostWorktreePath, listHostWorktrees, removeHostWorktree, type BranchOutcome } from './host-worktree'
import {
  describeLeftovers,
  observeEnvironmentResources,
  planLeftoverRemoval,
  removeLeftovers,
  unattributedResources,
  type Leftover,
  type RemovalOutcome
} from './leftovers'
import { RUNTIME_IMAGE } from './runtime-volume'

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
 * What makes it fixable is that a retired environment **keeps its row for
 * good**, and everything it owns is attributable to its id — by a name derived
 * from it, or by the `domo.env` label its Docker proxy stamped on what the
 * agent made. So the rows are an authoritative list of what should no longer
 * exist, and the leftovers of a failed cleanup are findable however much
 * later — a lookup rather than a race against a window, which is what lets the
 * retry be somebody's deliberate second go instead of a timer. `leftovers.ts` holds the attribution rule that keeps that
 * safe.
 *
 * The row is also the record: whatever is still there after a pass is written
 * to `dev_environments.leftovers`, which is what a retirement reports to
 * whoever asked for it instead of claiming success, and what the environment
 * page shows until a later pass clears it.
 */

export interface CleanupReport {
  removed: Leftover[]
  /** Claimed, still there, and not removable this time. Each with why. */
  leftovers: Array<Leftover & { error: string }>
  /**
   * Resources that look like this install's and no row accounts for. Never
   * removed — see `unattributedResources` — and named so a person can decide.
   */
  unattributed: string[]
  /**
   * The branches of environments whose worktree went this pass: deleted when
   * fully merged, kept with the reason otherwise (`deleteMergedBranch`).
   */
  branches: Array<BranchOutcome & { environmentId: string }>
  /** Set when Docker could not be asked at all: nothing was removed and nothing was recorded. */
  unreachable?: string
}

const EMPTY: CleanupReport = { removed: [], leftovers: [], unattributed: [], branches: [] }

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
  // A retired row claims what is named from its id only until a pass has seen
  // none of it left (`cleanedAt`). Nothing can be made for it after that, and a
  // path or name reusing its id later belongs to somebody else.
  const claimants = environments.filter(
    environment => (environment.retiredAt && !environment.cleanedAt) || environment.leftovers.length
  )

  let present
  try {
    present = await observeEnvironmentResources()
  } catch (error) {
    return { ...EMPTY, unreachable: error instanceof Error ? error.message : String(error) }
  }
  const projects = await listProjects(true)
  const unattributed = [
    ...unattributedResources({ environments, present }),
    ...await unattributedWorktrees(environments, projects)
  ]

  const outcome = await removeLeftovers(planLeftoverRemoval({ environments: claimants, present }))
  // After Docker's: the container that mounts a worktree has gone by now, or
  // it is itself a leftover and the worktree stays with it.
  const worktrees = await removeWorktreeLeftovers(claimants, projects)
  const branches = await settleBranches(claimants, projects, worktrees.failed)
  outcome.removed.push(...worktrees.removed)
  outcome.failed.push(...worktrees.failed)
  // After the container that installed into it, like the worktree.
  const dependencies = await removeDependencyLeftovers(claimants)
  outcome.removed.push(...dependencies.removed)
  outcome.failed.push(...dependencies.failed)
  unattributed.push(...dependencies.unattributed)
  const remaining = new Map<string, EnvironmentLeftover[]>()
  for (const failure of outcome.failed) {
    const list = remaining.get(failure.environmentId) ?? []
    list.push({ kind: failure.kind, name: failure.name, error: failure.error })
    remaining.set(failure.environmentId, list)
  }
  for (const environment of claimants) {
    const owed = remaining.get(environment.id) ?? []
    const wanted = health(environment, owed)
    // Retired rows are kept for good, so most claimants owe nothing and say
    // so already: no query for them, on every pass, for ever.
    const settled = !owed.length && !environment.leftovers.length
      && (!wanted || (environment.status === wanted.status && environment.lastError === wanted.lastError))
    if (!settled) await setEnvironmentLeftovers(environment.id, owed, wanted)
    // Confirmed clean: Docker was asked (an unreachable one returned above) and
    // the host was looked at. Without its project the worktree could not be,
    // so that row keeps its claim.
    const looked = projects.some(project => project.id === environment.projectId)
    if (environment.retiredAt && !owed.length && looked) await markEnvironmentCleaned(environment.id)
  }
  return { removed: outcome.removed, leftovers: outcome.failed, unattributed, branches }
}

/**
 * The branch half: once a claimant's worktree is gone, the branch Domo made for
 * it goes too if nothing would be lost (`deleteMergedBranch`). A branch that
 * existed before the environment is never touched, and neither is any other
 * branch the worktree may have been switched to. A worktree still there keeps
 * its branch checked out, so its branch waits for the pass that removes it.
 */
async function settleBranches(
  claimants: DevEnvironment[],
  projects: Project[],
  failed: Array<{ environmentId: string }>
): Promise<CleanupReport['branches']> {
  const repoPaths = new Map(projects.map(project => [project.id, project.repoPath]))
  const blocked = new Set(failed.map(failure => failure.environmentId))
  const outcomes: CleanupReport['branches'] = []
  for (const environment of claimants) {
    const repoPath = repoPaths.get(environment.projectId)
    if (!repoPath || !environment.branch || !environment.branchCreated || blocked.has(environment.id)) continue
    if (await hostWorktreeExists(repoPath, environment.id)) continue
    const outcome = await deleteMergedBranch(repoPath, environment.branch).catch(error => ({
      name: environment.branch!,
      deleted: false,
      reason: `It could not be checked: ${error instanceof Error ? error.message : String(error)}`
    }))
    if (outcome) outcomes.push({ ...outcome, environmentId: environment.id })
  }
  return outcomes
}

/**
 * The host half of a sweep: an environment's worktree, which is a directory
 * beside its project's checkout rather than anything Docker lists.
 *
 * The same attribution rule as Docker's: a retired row claims its worktree,
 * any row claims one a cleanup recorded as owed, and a live environment's is
 * never touched — it is the only copy of its agent's uncommitted work.
 * Whether it went is decided by looking at the disk afterwards.
 */
export async function removeWorktreeLeftovers(
  claimants: DevEnvironment[],
  projects: Project[]
): Promise<RemovalOutcome> {
  const outcome: RemovalOutcome = { removed: [], failed: [] }
  const repoPaths = new Map(projects.map(project => [project.id, project.repoPath]))
  for (const environment of claimants) {
    const repoPath = repoPaths.get(environment.projectId)
    if (!repoPath) continue
    const claimed = !!environment.retiredAt || environment.leftovers.some(owed => owed.kind === 'worktree')
    if (!claimed || !(await hostWorktreeExists(repoPath, environment.id))) continue
    const leftover = { kind: 'worktree' as const, name: hostWorktreePath(repoPath, environment.id), environmentId: environment.id }
    const result = await removeHostWorktree({ repoPath, environmentId: environment.id })
      .then(left => left.length
        ? { error: `Could not delete ${left.join(', ')}. Delete it by hand and run the cleanup again.` }
        : { error: null },
      error => ({ error: error instanceof Error ? error.message : String(error) }))
    if (result.error) outcome.failed.push({ ...leftover, error: result.error })
    else outcome.removed.push(leftover)
  }
  return outcome
}

/**
 * The cache-volume half: each environment's pnpm virtual store
 * (`caches.ts`), a directory named by its id. Removed for a claimant from a
 * helper container, in one run for the whole pass, and decided by listing the
 * directory afterwards. A live environment's is never touched, and one no row
 * knows is reported, not removed. Nothing at all when the volume does not
 * exist: asking would create it.
 */
export async function removeDependencyLeftovers(
  claimants: DevEnvironment[]
): Promise<RemovalOutcome & { unattributed: string[] }> {
  const outcome = { removed: [] as Leftover[], failed: [] as RemovalOutcome['failed'], unattributed: [] as string[] }
  const volume = sharedCacheVolumeName()
  const exists = await run('docker', ['volume', 'inspect', volume], { allowFailure: true })
    .then(result => result.stdout.trim().startsWith('[') && result.stdout.trim() !== '[]', () => false)
  if (!exists) return outcome
  const claimed = claimants.filter(environment =>
    !!environment.retiredAt || environment.leftovers.some(owed => owed.kind === 'dependencies'))
  const dir = '/c/pnpm-projects'
  const listed = await run('docker', [
    'run', '--rm', '--volume', `${volume}:/c`, RUNTIME_IMAGE,
    'sh', '-c', PNPM_PROJECTS_SWEEP_SCRIPT, 'sh', dir, ...claimed.map(environment => environment.id)
  ]).then(result => result.stdout.split('\n').map(line => line.trim()).filter(Boolean))
  const removing = new Set(listed.filter(line => line.startsWith('removing ')).map(line => line.slice('removing '.length)))
  const left = new Set(listed.filter(line => line.startsWith('left ')).map(line => line.slice('left '.length)))
  const known = new Set((await listDevEnvironments(undefined, true)).map(environment => environment.id))
  for (const environment of claimed) {
    const leftover = { kind: 'dependencies' as const, name: `${volume}:${pnpmProjectDir(environment.id).slice(CACHES_ROOT.length + 1)}`, environmentId: environment.id }
    if (left.has(environment.id)) outcome.failed.push({ ...leftover, error: 'It could not be deleted from the cache volume. Run the cleanup again.' })
    else if (removing.has(environment.id)) outcome.removed.push(leftover)
  }
  for (const id of left) if (!known.has(id)) outcome.unattributed.push(`dependencies ${volume}:pnpm-projects/${id}`)
  return outcome
}

/**
 * Worktrees beside a project's checkout that no environment row knows —
 * reported, never removed, for the same reason as Docker's: nothing here can
 * tell another install's live checkout from garbage.
 */
async function unattributedWorktrees(environments: DevEnvironment[], projects: Project[]): Promise<string[]> {
  const known = new Set(environments.map(environment => environment.id))
  const found = new Set<string>()
  for (const project of projects) {
    for (const id of await listHostWorktrees(project.repoPath)) {
      if (!known.has(id)) found.add(`worktree ${hostWorktreePath(project.repoPath, id)}`)
    }
  }
  return [...found]
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
 * not running any more. It costs nothing on an install that has never made an
 * environment — `reconcileEnvironmentResources` returns before asking Docker
 * anything — and four list calls otherwise.
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
  for (const branch of report.branches) {
    console.warn(`[dev-env] ${branch.deleted ? 'deleted' : 'kept'} branch ${branch.name} of environment ${branch.environmentId}. ${branch.reason}`)
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
