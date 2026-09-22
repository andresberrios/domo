import type {
  AgentSession,
  DevEnvironment,
  EnvironmentBranchImport,
  ImportPlan,
  ImportPlanSession
} from '../../shared/types'
import { acpManager } from './acp/manager'
import type { EnvironmentGit } from './dev-env/git-sync'
import { importBranch, resolveFromRef, runEnvironmentGit } from './dev-env/git-sync'
import { MAX_REPORTED_PATHS, parsePorcelain } from './dev-env/workspace-seed'
import { enqueueInboxMessage, getDevEnvironment, listAgentSessions } from './repo'

/**
 * Putting a branch into an environment *and* making sure the agents in it find
 * out — which is the half that makes an import worth anything.
 *
 * `importBranch` moves refs, and that is not enough on its own, twice over. An
 * import into a branch the agent is *not* on is **inert**: nothing in a
 * container tells an agent that some other branch moved, so it never merges
 * what it never hears about. And the branch it *is* on cannot be pushed to at
 * all, because a working tree is attached to it.
 *
 * So for the branch the environment has checked out, the order is what makes
 * this safe, and it is the same principle as the workspace reconcile: **the
 * only work that can be lost is work git cannot see.**
 *
 * 1. **Commit whatever is uncommitted**, on the branch it is already on, as a
 *    Domo-authored WIP commit. Nothing is stashed and nothing is discarded, so
 *    from here on everything is recoverable — reset it, amend it, cherry-pick
 *    out of it. That is what lets the rest of this be bold.
 * 2. **Merge, for real.** Once there is a commit the branch has genuinely
 *    diverged and `--ff-only` is the wrong tool; a clean merge is the expected
 *    outcome and the end of it. With nothing to commit and nothing diverged the
 *    same call simply fast-forwards.
 * 3. **On conflict, abort.** The imported commits stay on the side branch and
 *    the agent is told which one and that it conflicts. A half-merged working
 *    tree left under a running agent is worse than no import at all: it reads
 *    the conflict markers as its own work.
 *
 * A turn in flight skips all of that and leaves the branch on the side ref,
 * because committing and merging under a running agent is its own way of
 * destroying work — it is holding files open and about to write more.
 *
 * Every path ends with the agent either holding the changes or holding a
 * message saying where they are. An import is never silent.
 *
 * This lives above `dev-env/` rather than inside it for the same reason
 * `projects.ts` does: it needs `acpManager`, and `dev-env/` is the layer
 * `acpManager` itself imports.
 */

/** Where the imported commits land when they are going to be merged rather than pushed. */
export function sideBranch(branch: string): string {
  return `domo-import/${branch}`
}

/** The commit an agent's uncommitted work is parked in before a merge. */
export function wipMessage(branch: string): string {
  return `chore: Domo committed work in progress on ${branch}\n\n`
    + 'These files were uncommitted in this environment when a branch was imported\n'
    + 'from the host. Committing them first is what makes the merge that follows\n'
    + 'safe: nothing was stashed and nothing was discarded, so this commit is\n'
    + 'yours to amend, reset or cherry-pick out of.\n'
}

/** The branch the environment is on, or null when its HEAD is detached. */
async function checkedOutBranch(environment: DevEnvironment, git: EnvironmentGit): Promise<string | null> {
  const head = await git(environment, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
    .catch(() => ({ stdout: '', stderr: '' }))
  return head.stdout.trim() || null
}

/** Sessions in this environment that could care, newest activity first. */
async function sessionsIn(environmentId: string): Promise<AgentSession[]> {
  return (await listAgentSessions()).filter(session => session.devEnvironmentId === environmentId)
}

/**
 * How to hand a working agent something it did not ask for.
 *
 * `steer` injects into the running turn, which is what this is: a human has
 * decided the agent needs these changes now. But **steer on an adapter that
 * does not advertise it becomes `interrupt`**, never `queue` — and cancelling
 * a turn to hand over a branch is far blunter than the news deserves. Measured:
 * an `initialize` to each answers `_meta.steering.supported: true` for
 * claude-agent-acp and **no `_meta` at all** for opencode; codex-acp sets it in
 * its own bundle. So the adapter that cannot be steered is queued rather than
 * interrupted, and nobody has to keep a list of adapter names in step — the
 * connection itself is asked, so an adapter that gains steering tomorrow is
 * steered without anything here changing.
 */
function deliveryFor(agentSessionId: string): 'steer' | 'queue' {
  return acpManager.supportsSteering(agentSessionId) ? 'steer' : 'queue'
}

interface Notice {
  branch: string
  from: string
  count: number
  /** The WIP commit, when there was uncommitted work to park. */
  wip: string | null
  outcome: 'merged' | 'up-to-date' | 'side-branch' | 'conflict'
  checkedOut: string | null
  /** The one session asked to merge by hand, when anything was left to merge. */
  resolver: ImportPlanSession | null
  /** Which session is being written to, so the asked one is addressed directly. */
  reader: string
}

/**
 * The one message, phrased so that no second one is ever needed.
 *
 * It says what is true at the moment it is sent and stays true afterwards: the
 * commits are on this ref, they conflict (or not), and *this* session has been
 * **asked** to merge them. Nothing has to observe whether that session gets to
 * it — "is being handled" would be a claim about the future, and keeping it
 * honest would mean detecting when a merge finished, which an agent ending its
 * turn does not tell you. Any of the others can pick it up, and the note reads
 * the same either way.
 */
function noticeFor(notice: Notice): string {
  const commits = `${notice.count} commit${notice.count === 1 ? '' : 's'}`
  const parked = notice.wip
    ? ` Uncommitted work here was committed first, as ${notice.wip.slice(0, 8)} — nothing was stashed or `
      + 'discarded, so amend or reset that commit if it was mid-thought.'
    : ''
  const asked = !notice.resolver
    ? ` Merge it when you can: \`git merge ${notice.branch}\`.`
    : notice.resolver.agentSessionId === notice.reader
      ? ` You have been asked to merge it: \`git merge ${notice.branch}\`.`
      : ` ${notice.resolver.title} (${notice.resolver.agentSessionId}) has been asked to merge it, so leave `
        + 'it to them unless they do not get to it — you share one checkout, and two of you merging at once '
        + 'would be editing the same files.'

  switch (notice.outcome) {
    case 'merged':
      return `Domo imported "${notice.from}" from the host (${commits}) and merged it into `
        + `"${notice.checkedOut}".${parked}`
    case 'up-to-date':
      return `Domo imported "${notice.from}" from the host, and "${notice.checkedOut}" already had all of `
        + `it.${parked}`
    case 'conflict':
      return `Domo imported "${notice.from}" from the host (${commits}) onto "${notice.branch}", but merging `
        + `it into "${notice.checkedOut}" conflicts, so the merge was aborted and the working tree is as it `
        + `was.${parked}${asked}`
    default:
      return `Domo imported "${notice.from}" from the host (${commits}) onto "${notice.branch}". `
        + `"${notice.checkedOut ?? 'No branch'}" is checked out here.${parked}${asked}`
  }
}

/**
 * Tell one session where the changes are.
 *
 * A **working** session is delivered to, because it is in a position to act.
 * An **idle** one gets the inbox row written directly and nothing else — the
 * same thing `subscriptions.ts` does, and for the same reason: `deliver()`
 * *starts the adapter it delivers to*, so a note about a branch would spawn a
 * process for every stopped session in the environment. The row is what the
 * agent page shows as waiting, and the inbox drains on its own when an adapter
 * next attaches idle or finishes a turn.
 *
 * Origin `system`, which reads as "[From Domo]": this is Domo's own notice
 * about something Domo did, not the words of whoever asked for the import —
 * exactly the case subscription notes already use it for.
 */
async function tell(session: ImportPlanSession, text: string): Promise<'steer' | 'queue' | 'inbox'> {
  const content = [{ type: 'text', text }]
  const id = session.agentSessionId
  if (acpManager.isBusy(id)) {
    const delivery = deliveryFor(id)
    await acpManager.deliver(id, { content, delivery, origin: 'system' })
    return delivery
  }
  await enqueueInboxMessage({ agentSessionId: id, content, delivery: 'queue', origin: 'system' })
  return 'inbox'
}

/**
 * Everything the plan is worked out from. Observed once, so the description a
 * person is shown and the work that is actually done come from one reading of
 * the environment rather than two.
 */
export interface ImportState {
  requested: string
  from: string
  /** The branch the environment has checked out, or null when its HEAD is detached. */
  checkedOut: string | null
  /** Paths `git status --porcelain` reports in the environment. */
  dirty: string[]
  /** Sessions in this environment, **most recently active first**. */
  sessions: ImportPlanSession[]
}

/**
 * What an import would do, from what was observed. Pure, and the only place
 * the decision is made: `importBranchIntoEnvironment` carries this out rather
 * than working it out again, and the modal renders the same structure. A
 * button whose behaviour the user cannot predict is a button they are afraid
 * to press, and the only way to guarantee the preview and the act agree is for
 * both to read one function.
 */
export function planImport(state: ImportState): ImportPlan {
  const intoCheckedOut = state.requested === state.checkedOut
  const working = state.sessions.some(session => session.busy)
  // A turn in flight is holding files open and about to write more, so nothing
  // touches the working tree: the commits go to a ref of their own and an agent
  // is asked to merge them when it reaches a sensible point.
  const toSideBranch = intoCheckedOut && working
  const merge = intoCheckedOut && !working

  /**
   * One session, not all of them. Every session in an environment shares the
   * one workspace volume — one checkout, one working tree — so asking two to
   * resolve the same merge has them editing the same files at once, and the
   * second finds the first's half-finished work. The most recently active is
   * this codebase's existing answer to "which agent did the user mean"; it is
   * what `last_activity_at` is for and what the voice agent picks.
   */
  const resolver = state.sessions[0] ?? null

  return {
    requested: state.requested,
    from: state.from,
    branch: intoCheckedOut ? sideBranch(state.requested) : state.requested,
    toSideBranch,
    sideBranchReason: toSideBranch ? 'agent-mid-turn' : null,
    checkedOut: state.checkedOut,
    // Only ever before a merge: a push to a branch nobody has checked out does
    // not go near the working tree, so there is nothing to protect.
    commitFirst: merge && state.dirty.length
      ? { paths: state.dirty.slice(0, MAX_REPORTED_PATHS), total: state.dirty.length }
      : null,
    merge,
    notify: state.sessions,
    // Named whenever anything could be left to merge by hand — on a side
    // branch always, and after a merge only if it conflicts. Which of those it
    // turns out to be is not knowable until the merge is tried, so the plan
    // says who would be asked rather than pretending to know whether they will.
    resolver
  }
}

/** Read the environment once, for both the preview and the act. */
export async function observeImportState(input: {
  environment: DevEnvironment
  git: EnvironmentGit
  requested: string
  from?: string | null
}): Promise<ImportState> {
  const status = await input.git(input.environment, ['status', '--porcelain', '-z'], { allowFailure: true })
    .catch(() => ({ stdout: '', stderr: '' }))
  const sessions = await sessionsIn(input.environment.id)
  return {
    requested: input.requested,
    from: resolveFromRef(input.requested, input.from),
    checkedOut: await checkedOutBranch(input.environment, input.git),
    dirty: parsePorcelain(status.stdout),
    sessions: sessions.map(session => ({
      agentSessionId: session.id,
      title: session.title,
      busy: acpManager.isBusy(session.id)
    }))
  }
}

/** What would happen if this import ran right now. */
export async function previewImport(input: ImportIntoEnvironmentInput): Promise<ImportPlan> {
  const environment = await getDevEnvironment(input.environmentId)
  if (!environment) throw new Error('Development environment not found.')
  return planImport(await observeImportState({
    environment,
    git: input.environmentGit ?? runEnvironmentGit,
    requested: input.branch.trim(),
    from: input.from
  }))
}

/**
 * Commit whatever is uncommitted, and answer with the commit it made.
 *
 * `--no-verify` because a project's commit hooks are its own tooling and have
 * no business deciding whether a branch can be imported. An identity is
 * supplied only when the environment has none: the generated `~/.gitconfig`
 * includes the host's, so usually it does and the developer's own name lands
 * on their own work.
 */
async function commitWorkInProgress(
  environment: DevEnvironment,
  git: EnvironmentGit,
  branch: string
): Promise<string | null> {
  const status = await git(environment, ['status', '--porcelain'])
  if (!status.stdout.trim()) return null

  const identity = await git(environment, ['config', 'user.email'], { allowFailure: true })
    .catch(() => ({ stdout: '', stderr: '' }))
  const asDomo = identity.stdout.trim()
    ? []
    : ['-c', 'user.name=Domo', '-c', 'user.email=domo@localhost']

  await git(environment, ['add', '--all'])
  await git(environment, [...asDomo, 'commit', '--quiet', '--no-verify', '-m', wipMessage(branch)])
  return (await git(environment, ['rev-parse', 'HEAD'])).stdout.trim() || null
}

export interface ImportIntoEnvironmentInput {
  environmentId: string
  /** The branch the caller wants the environment to have. */
  branch: string
  /** The ref in the project's checkout to send. Defaults to the branch's own name. */
  from?: string | null
  /** How the host reaches the environment's repository. Injected by the tests. */
  transport?: (environment: DevEnvironment) => string
  /** How git is run inside the environment. Injected by the tests. */
  environmentGit?: EnvironmentGit
}

export async function importBranchIntoEnvironment(
  input: ImportIntoEnvironmentInput
): Promise<EnvironmentBranchImport> {
  const git = input.environmentGit ?? runEnvironmentGit
  const environment = await getDevEnvironment(input.environmentId)
  if (!environment) throw new Error('Development environment not found.')

  // Observed now, not trusted from a preview the caller may have taken minutes
  // ago: a turn can start and files can change in between, and acting on what
  // is true when the button is pressed is the honest thing.
  const plan = planImport(await observeImportState({
    environment,
    git,
    requested: input.branch.trim(),
    from: input.from
  }))

  // Before the push, and before anything else touches the checkout: the only
  // work that can be lost is work git cannot see.
  const wip = plan.commitFirst ? await commitWorkInProgress(environment, git, plan.requested) : null

  const pushed = await importBranch({
    environmentId: input.environmentId,
    branch: plan.branch,
    from: plan.from,
    transport: input.transport
  })
  const report: EnvironmentBranchImport = { ...pushed, requested: plan.requested, wip, notified: [] }
  if (pushed.result === 'not-merged') return report

  let outcome: Notice['outcome'] = 'side-branch'
  if (plan.merge) {
    const head = async () => (await git(environment, ['rev-parse', 'HEAD'])).stdout.trim()
    const before = await head()
    // No `allowFailure`: the exit code *is* the answer. A conflict leaves the
    // tree half-merged, so the abort is not optional.
    const clean = await git(environment, ['merge', '--no-edit', plan.branch]).then(() => true, () => false)
    if (clean) {
      outcome = (await head()) === before ? 'up-to-date' : 'merged'
      report.result = outcome === 'up-to-date' ? 'up-to-date' : 'merged'
    } else {
      await git(environment, ['merge', '--abort'], { allowFailure: true }).catch(() => {})
      outcome = 'conflict'
      report.result = 'not-merged'
      report.reason = `The imported commits are on "${plan.branch}", but merging them into `
        + `"${plan.checkedOut}" conflicts. The merge was aborted, so the environment's working tree is `
        + 'untouched.'
    }
  } else if (plan.toSideBranch) {
    report.diverted = `An agent is mid-turn in this environment, so "${plan.requested}" was left on `
      + `"${plan.branch}" rather than merged under a running working tree.`
  }

  // Exactly one session is *asked*, and only when something is left to merge.
  // They all share one workspace volume, so two of them acting on the same
  // conflict would be editing the same files at once.
  const resolver = outcome === 'merged' || outcome === 'up-to-date' ? null : plan.resolver
  report.resolver = resolver
  for (const session of plan.notify) {
    const text = noticeFor({
      branch: plan.branch,
      from: pushed.from,
      count: pushed.commits.length,
      wip,
      outcome,
      checkedOut: plan.checkedOut,
      resolver,
      reader: session.agentSessionId
    })
    const via = await tell(session, text).catch((error) => {
      console.error(`[branch-import] could not tell ${session.agentSessionId} about ${plan.branch}`, error)
      return null
    })
    if (via) report.notified.push({ agentSessionId: session.agentSessionId, title: session.title, via })
  }
  return report
}
