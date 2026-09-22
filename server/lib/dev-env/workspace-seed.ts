import type { WorkingTreeMode, WorkspaceSeedReport } from '../../../shared/types'
import { run } from './docker'

/**
 * Making the environment's git agree with the environment's files.
 *
 * `populateWorkspaceVolume()` tars the host's *working tree*, so an environment
 * created while the host was dirty starts with a checkout that does not match
 * the HEAD copied beside it. Nothing warns about that, and the agent inside has
 * no way to tell which of those changes are its own: the first `git add -A`
 * sweeps the host's uncommitted work into the agent's branch, and
 * `exportBranch()` — whose entire value is that the diff coming back is
 * trustworthy — carries it home as if the agent had written it. That is how a
 * superseded colour palette nearly got merged back over its replacement.
 *
 * So the working tree is reconciled with HEAD once, before anything else runs
 * in the container, in whichever of the two honest directions the caller asked
 * for:
 *
 * - **discard** (the default): make the files match git. Tracked files go back
 *   to HEAD and untracked-but-not-ignored files are removed. Nothing is lost —
 *   the host's own checkout is only ever *read*, so this throws away a copy.
 * - **carry**: make git match the files. Everything git would stage is
 *   committed, with a message that says where it came from, so the change is
 *   still in the export but it arrives labelled instead of disguised.
 *
 * **Ignored files are kept in both modes**, and that is the line the property
 * itself draws rather than a convenience: an ignored file cannot enter a commit
 * without being force-added, so it can never make the returning diff lie. That
 * is also what keeps `node_modules` (the reason the volume and its tar exist at
 * all — bind mounts on Docker Desktop were measured 15-35x slower) and a
 * gitignored `.env` in place. An untracked file that is *not* ignored is on the
 * other side of the same line: `git add -A` will take it, so in `discard` mode
 * it goes.
 *
 * Populating from `git archive HEAD` plus a second pass for the ignored files
 * was the other candidate. It moves less over the pipe, but the environment
 * needs a real `.git` anyway (the agent commits; the export fetches), so the
 * object store is copied either way — and once it is there, resetting to it is
 * exact and needs no second list of "the ignored files that actually matter" to
 * keep right.
 */

/** How many dirty paths are named back to the caller before the list is cut short. */
export const MAX_REPORTED_PATHS = 20

/**
 * The script that reconciles the copied checkout, run through `docker exec` as the
 * environment's own user. Everything variable arrives as argv; nothing is interpolated.
 *
 * `--no-verify` because a project's own commit hooks are the host's tooling and
 * have no business deciding whether an environment can be created. The
 * `rebase-*` directories are removed rather than reset because they name the
 * host's in-progress operation, and an environment that believes it is halfway
 * through a rebase nobody started is its own kind of lie.
 */
export const RECONCILE_SCRIPT = [
  'set -e',
  'mode="$1"; workspace="$2"; message="$3"',
  'cd "$workspace"',
  'if ! git rev-parse --verify --quiet HEAD >/dev/null 2>&1; then',
  '  echo "no-head" >&2',
  '  exit 0',
  'fi',
  'if [ "$mode" = carry ]; then',
  '  git config user.email >/dev/null 2>&1 || git config user.email domo@localhost',
  '  git config user.name >/dev/null 2>&1 || git config user.name Domo',
  '  git add -A',
  '  if git diff --cached --quiet; then exit 0; fi',
  '  git commit --quiet --no-verify -m "$message"',
  '  git rev-parse HEAD',
  'else',
  '  rm -rf .git/rebase-merge .git/rebase-apply .git/sequencer',
  '  git reset --hard --quiet',
  '  git clean -fdq',
  'fi'
].join('\n')

/**
 * The argv after the `docker exec …` prefix. Split out from the exec itself so
 * the script and its arguments can be pinned without a daemon.
 */
export function reconcileArgs(input: {
  mode: WorkingTreeMode
  workspacePath: string
  message: string
}): string[] {
  return ['sh', '-c', RECONCILE_SCRIPT, 'sh', input.mode, input.workspacePath, input.message]
}

/**
 * `git status --porcelain -z` into plain paths. A rename or a copy is followed
 * by its *source* path as a second NUL-terminated field, which is one entry and
 * not two.
 */
export function parsePorcelain(output: string): string[] {
  const fields = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length; index++) {
    const entry = fields[index]
    if (!entry || entry.length < 4) continue
    paths.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') index++
  }
  return paths
}

/**
 * What the host checkout has that its HEAD does not, as git sees it. Read
 * before the tar, and only to be able to say what happened: a failure here
 * means the report is empty, never that the reconcile is skipped.
 */
export async function readHostWorkingTree(repoPath: string): Promise<string[]> {
  const listed = await run('git', ['-C', repoPath, 'status', '--porcelain', '-z'], { trimOutput: false })
    .catch((error) => {
      console.warn(`[dev-env] could not read the working tree of ${repoPath}: ${error}`)
      return { stdout: '', stderr: '' }
    })
  return parsePorcelain(listed.stdout)
}

/** The seed report for a set of dirty paths, with the list cut to something printable. */
export function seedReport(input: {
  mode: WorkingTreeMode
  paths: string[]
  commit?: string | null
}): WorkspaceSeedReport {
  return {
    mode: input.mode,
    paths: input.paths.slice(0, MAX_REPORTED_PATHS),
    total: input.paths.length,
    commit: input.commit ?? null
  }
}

/** The commit message a carried working tree is recorded under. */
export function carryMessage(input: { environmentName: string, repoPath: string }): string {
  return `chore: carry the host's uncommitted changes into ${input.environmentName}\n\n`
    + `These changes were uncommitted in ${input.repoPath} when this Domo development\n`
    + 'environment was created, and were committed here so the environment\'s git\n'
    + 'agrees with its files. They are not this session\'s work: review them before\n'
    + 'merging this branch back.\n'
}

/** One English sentence about what happened to the host's working tree, for a tool result or a toast. */
export function describeSeed(report: WorkspaceSeedReport): string {
  const count = `${report.total} uncommitted ${report.total === 1 ? 'path' : 'paths'}`
  if (report.total === 0) return 'The host checkout had no uncommitted changes.'
  if (report.mode === 'carry') {
    return report.commit
      ? `Carried ${count} from the host and committed them as ${report.commit.slice(0, 12)}.`
      : `Carried ${count} from the host.`
  }
  return `Left ${count} behind on the host; the environment starts from the project's last commit.`
}
