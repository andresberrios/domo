import type { AgentSession, DevEnvironment, EnvironmentBranchImport } from '../../shared/types'
import { acpManager } from './acp/manager'
import { importBranch, listEnvironmentBranches, resolveFromRef } from './dev-env/git-sync'
import { enqueueInboxMessage, listAgentSessions } from './repo'

/**
 * Putting a branch into an environment *and* making sure the agents in it find
 * out — which is the half that makes an import worth anything.
 *
 * `importBranch` moves refs. That is not enough on its own: an import into a
 * branch the agent is not on is **inert**, because nothing in a container ever
 * tells an agent that some other branch moved. It will never merge what it
 * never hears about. So the common case is precisely the one that sounds
 * dangerous — writing the branch the agent has checked out — and what decides
 * whether that is safe is what the session is *doing*, not which branch it
 * happens to be on:
 *
 * - **Idle, clean tree** → straight into the checked-out branch. The working
 *   tree moves with the ref (`receive.denyCurrentBranch=updateInstead`), so
 *   the agent simply finds the files it should have.
 * - **Dirty tree** → refused by `importBranch`, and nothing is sent. Git
 *   refuses it too. Uncommitted work in a container has no second copy.
 * - **Mid-turn** → the branch lands beside the agent instead, under
 *   `domo-import/<branch>`, and the agent is *told*: its working tree is live,
 *   and swapping files under a running turn is its own way of destroying work.
 *
 * Every path ends in the agent either holding the changes or holding a message
 * saying where they are. An import is never silent.
 *
 * This lives above `dev-env/` rather than inside it for the same reason
 * `projects.ts` does: it needs `acpManager`, and `dev-env/` is the layer
 * `acpManager` itself imports.
 */

/** Where a branch lands when it cannot go to the one the agent is working on. */
export function sideBranch(branch: string): string {
  return `domo-import/${branch}`
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
 * an `initialize` to each answers
 * `_meta.steering.supported: true` for claude-agent-acp and **no `_meta` at
 * all** for opencode; codex-acp sets it in its own bundle. So the adapter that cannot
 * be steered is queued rather than interrupted, and nobody has to keep a list
 * of adapter names in step — the connection itself is asked, so an adapter that
 * gains steering tomorrow is steered without anything here changing.
 */
function deliveryFor(agentSessionId: string): 'steer' | 'queue' {
  return acpManager.supportsSteering(agentSessionId) ? 'steer' : 'queue'
}

function noticeFor(input: {
  branch: string
  requested: string
  from: string
  sha: string
  count: number
  diverted: boolean
  checkedOut: string | null
}): string {
  const commits = `${input.count} commit${input.count === 1 ? '' : 's'}`
  if (input.diverted) {
    return `Domo imported "${input.from}" from the host into this environment while you were working, `
      + `so it landed on "${input.branch}" (${input.sha.slice(0, 8)}, ${commits}) instead of your own branch. `
      + `Merge it when you reach a sensible point: \`git merge ${input.branch}\`.`
  }
  if (input.checkedOut === input.branch) {
    return `Domo fast-forwarded your checked-out branch "${input.branch}" to ${input.sha.slice(0, 8)} `
      + `with ${commits} from the host. Your working tree was updated with it; nothing of yours was changed.`
  }
  return `Domo imported "${input.from}" from the host into this environment, onto "${input.branch}" `
    + `(${input.sha.slice(0, 8)}, ${commits}). You have "${input.checkedOut ?? 'no branch'}" checked out, `
    + `so merge it when convenient: \`git merge ${input.branch}\`.`
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
async function tell(session: AgentSession, text: string): Promise<'steer' | 'queue' | 'inbox'> {
  const content = [{ type: 'text', text }]
  if (acpManager.isBusy(session.id)) {
    const delivery = deliveryFor(session.id)
    await acpManager.deliver(session.id, { content, delivery, origin: 'system' })
    return delivery
  }
  await enqueueInboxMessage({ agentSessionId: session.id, content, delivery: 'queue', origin: 'system' })
  return 'inbox'
}

export interface ImportIntoEnvironmentInput {
  environmentId: string
  /** The branch the caller wants the environment to have. */
  branch: string
  /** The ref in the project's checkout to send. Defaults to the branch's own name. */
  from?: string | null
  /** Injected by the tests, and passed straight through. */
  transport?: (environment: DevEnvironment, config?: string[]) => string
  workingTree?: (environment: DevEnvironment) => Promise<string>
}

export async function importBranchIntoEnvironment(
  input: ImportIntoEnvironmentInput
): Promise<EnvironmentBranchImport> {
  const requested = input.branch.trim()
  const sessions = await sessionsIn(input.environmentId)
  const working = sessions.filter(session => acpManager.isBusy(session.id))

  const { current } = await listEnvironmentBranches(input.environmentId)
  // Only a turn in flight forces the branch aside. A dirty tree does not: the
  // import refuses that outright, and refusing is more useful than quietly
  // landing somewhere the caller did not ask for.
  const diverted = working.length > 0 && requested === current
  const branch = diverted ? sideBranch(requested) : requested
  // Resolved against what was *asked for*, not against where it is going: a
  // default `from` means "the branch of the same name on the host", and there
  // is no `domo-import/main` there to send.
  const from = resolveFromRef(requested, input.from)

  const result = await importBranch({
    environmentId: input.environmentId,
    branch,
    from,
    transport: input.transport,
    workingTree: input.workingTree
  })

  const report: EnvironmentBranchImport = {
    ...result,
    requested,
    notified: [],
    ...(diverted
      ? {
          diverted: `An agent is mid-turn in this environment, so "${requested}" was left on `
            + `"${branch}" rather than written under a running working tree.`
        }
      : {})
  }
  // Nothing landed, so there is nothing to tell anybody about; the caller has
  // the reason and is the one who can act on it.
  if (result.result === 'not-merged') return report

  const text = noticeFor({
    branch,
    requested,
    from: result.from,
    sha: result.sha,
    count: result.commits.length,
    diverted,
    checkedOut: current
  })
  for (const session of sessions) {
    const via = await tell(session, text).catch((error) => {
      console.error(`[branch-import] could not tell ${session.id} about ${branch}`, error)
      return null
    })
    if (via) report.notified.push({ agentSessionId: session.id, title: session.title, via })
  }
  return report
}
