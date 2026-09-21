import type { BranchExport, BranchExportResult, DevEnvironment, EnvironmentBranches } from '../../../shared/types'
import { safeEnvironmentName } from '../dev-environments'
import { getDevEnvironment, getProject } from '../repo'
import { homeDirectory } from './container'
import { run } from './docker'

/**
 * Getting a branch out of an environment without going through GitHub.
 *
 * The checkout lives in a Docker volume, so the host repository cannot see it
 * as a path — but it does not need to. Git's `ext::` transport runs an
 * arbitrary command and speaks the pack protocol over its stdin/stdout, so
 * `docker exec … git-upload-pack <workspace>` is a perfectly ordinary remote:
 * a real fetch, with real negotiation, where only the missing objects cross.
 *
 * Nothing here ever force-updates, merges or rebases a *local* branch. The
 * worst case is "fetched to the tracking ref and stopped", which the caller
 * reports with the reason.
 */

/** Where an environment's branches land in the host repository. */
export const TRACKING_NAMESPACE = 'domo-env'

export interface UploadPackTransportInput {
  containerId: string
  /** The environment's remote user. Null only for a container that never recorded one. */
  remoteUser: string | null
  /** That user's home directory, which git needs set to find its own config. */
  home: string | null
  workspacePath: string
}

/** How many commits are listed back; a first export of a long branch is not a changelog. */
const MAX_LISTED_COMMITS = 50
/** Field separator for the git formats below: it cannot occur in a ref name or a subject. */
const FIELD = '\u001f'

/**
 * Git splits an `ext::` command on whitespace and expands `%`-escapes in it, so
 * every part of it has to be a single bare word. All of these are: the
 * workspace path comes from `safeEnvironmentName()`, a container id is hex and
 * a remote user is a unix name. It is still checked, because the failure mode
 * of a value that is not is a command that quietly means something else.
 */
function word(value: string, what: string): string {
  if (!value || /[\s%]/.test(value)) {
    throw new Error(`Cannot reach the environment's repository: its ${what} (${value || 'empty'}) is not a plain word.`)
  }
  return value
}

/**
 * The URL a host `git fetch` uses to read the environment's repository.
 *
 * `-u`/`HOME` are not decoration: git refuses a checkout owned by another uid
 * with "dubious ownership", and the `safe.directory` that answers that is in
 * the remote user's generated `~/.gitconfig`.
 */
export function uploadPackTransport(input: UploadPackTransportInput): string {
  const command = ['docker', 'exec', '-i']
  if (input.remoteUser) command.push('-u', word(input.remoteUser, 'user'))
  if (input.home) command.push('-e', `HOME=${word(input.home, 'home directory')}`)
  command.push(
    word(input.containerId, 'container id'),
    'git-upload-pack',
    word(input.workspacePath, 'workspace path')
  )
  return `ext::${command.join(' ')}`
}

/** `into` defaults to the branch's own name; an explicit null or a blank one means fetch only. */
export function resolveIntoBranch(branch: string, into: string | null | undefined): string | null {
  if (into === undefined) return branch
  return (into ?? '').trim() || null
}

function safeRefComponent(value: string, what: string): string {
  if (!value || value.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{/.test(value)) {
    throw new Error(`"${value}" is not a valid ${what} name.`)
  }
  return value
}

/** `run()` prefixes a failure with the program and its first argument; the stderr is the part a person needs. */
function commandMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\S+ \S+ failed: /, '')
}

async function environmentAndProject(environmentId: string) {
  const environment = await getDevEnvironment(environmentId)
  if (!environment) throw new Error('Development environment not found.')
  const project = await getProject(environment.projectId)
  if (!project) throw new Error('The environment\'s project no longer exists.')
  return { environment, project }
}

function containerReference(environment: DevEnvironment): string {
  const reference = environment.containerId || environment.containerName
  if (!reference) throw new Error(`${environment.name} has no container. Create the environment again.`)
  return reference
}

function defaultTransport(environment: DevEnvironment): string {
  return uploadPackTransport({
    containerId: containerReference(environment),
    remoteUser: environment.remoteUser,
    home: environment.remoteUser ? homeDirectory(environment.remoteUser) : null,
    workspacePath: environment.workspacePath
  })
}

/** The branches in an environment's checkout, and the one it has checked out. */
export async function listEnvironmentBranches(environmentId: string): Promise<EnvironmentBranches> {
  const { environment } = await environmentAndProject(environmentId)
  const exec = ['exec']
  if (environment.remoteUser) exec.push('--user', environment.remoteUser)
  exec.push('--workdir', environment.workspacePath, containerReference(environment))

  const listed = await run('docker', [
    ...exec,
    'git', 'for-each-ref', `--format=%(refname:short)${FIELD}%(objectname)${FIELD}%(contents:subject)`,
    'refs/heads'
  ]).catch((error) => {
    const message = commandMessage(error)
    if (/is not running|No such container/i.test(message)) {
      throw new Error(`${environment.name} is not running. Start it to see its branches.`)
    }
    throw new Error(`Could not list the branches in ${environment.name}: ${message}`)
  })
  const head = await run('docker', [...exec, 'git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowFailure: true
  }).catch(() => ({ stdout: '', stderr: '' }))

  return {
    current: head.stdout.trim() || null,
    branches: listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name = '', sha = '', subject = ''] = line.split(FIELD)
        return { name, sha, subject }
      })
      .filter(branch => branch.name && branch.sha)
  }
}

export interface ExportBranchInput {
  environmentId: string
  /** The branch in the environment. */
  branch: string
  /** The local branch to fast-forward. Null (or absent) fetches without touching one. */
  into?: string | null
  /** How the host reaches the environment's repository. Injected by the tests. */
  transport?: (environment: DevEnvironment) => string
}

/**
 * Fetch one branch out of an environment, and fast-forward a local branch onto
 * it when asked. Fast-forward only, in every direction: a diverged branch is
 * reported, never rewritten.
 */
export async function exportBranch(input: ExportBranchInput): Promise<BranchExport> {
  const branch = safeRefComponent(input.branch.trim(), 'branch')
  const into = input.into == null ? null : safeRefComponent(input.into.trim(), 'branch')
  const { environment, project } = await environmentAndProject(input.environmentId)
  const url = (input.transport ?? defaultTransport)(environment)
  const ref = `refs/remotes/${TRACKING_NAMESPACE}/${safeEnvironmentName(environment.name) || environment.id}/${branch}`

  const git = (args: string[], options: { allowFailure?: boolean } = {}) =>
    run('git', args, { cwd: project.repoPath, ...options })
  const revision = async (name: string): Promise<string | null> =>
    (await git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], { allowFailure: true })
      .catch(() => ({ stdout: '' }))).stdout.trim() || null

  const previous = await revision(ref)
  // `protocol.ext.allow` is passed here and never written to a config: nothing
  // else on this machine gains a transport that runs arbitrary commands. The
  // refspec forces only the tracking ref, exactly as a normal remote's
  // `+refs/heads/*:refs/remotes/<name>/*` does — the local branch below is
  // still fast-forward only.
  await git([
    '-c', 'protocol.ext.allow=always',
    'fetch', '--no-tags', '--quiet', url, `+refs/heads/${branch}:${ref}`
  ]).catch((error) => {
    const message = commandMessage(error)
    if (/couldn't find remote ref|no such ref/i.test(message)) {
      throw new Error(`${environment.name} has no branch called "${branch}".`)
    }
    if (/is not running|No such container/i.test(message)) {
      throw new Error(`${environment.name} is not running. Start it and try the export again.`)
    }
    throw new Error(`Could not fetch "${branch}" from ${environment.name}: ${message}`)
  })

  const sha = (await revision(ref))!
  const intoSha = into ? await revision(`refs/heads/${into}`) : null
  // What came over: measured against the local branch when there is one, else
  // against where the tracking ref stood. On a first export there is neither,
  // and "everything the host did not already have" is the honest answer —
  // anything else would list the whole history the branch was cut from.
  const base = intoSha ?? previous
  const range = base ? [`${base}..${sha}`] : [sha, '--not', `--exclude=${ref}`, '--all']
  const log = await git([
    'log', `--max-count=${MAX_LISTED_COMMITS}`, `--format=%H${FIELD}%s`, ...range
  ], { allowFailure: true }).catch(() => ({ stdout: '' }))
  const commits = log.stdout.split('\n').filter(Boolean).map((line) => {
    const [commit = '', subject = ''] = line.split(FIELD)
    return { sha: commit, subject }
  })

  const done = (result: BranchExportResult, reason?: string): BranchExport =>
    ({ ref, sha, commits, into, result, ...(reason ? { reason } : {}) })

  if (!into) {
    return done('not-merged', `Fetched to ${ref}. No local branch was named, so nothing was merged.`)
  }
  if (intoSha === sha) return done('up-to-date')

  const head = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true })
    .catch(() => ({ stdout: '' }))).stdout.trim()
  // The one branch whose ref cannot simply be moved: the working tree and the
  // index belong to it, and `update-ref` would leave both describing the wrong
  // commit. Its own local work is never at risk of being written over.
  const checkedOut = head === into
  if (checkedOut) {
    const status = await git(['status', '--porcelain'])
    if (status.stdout.trim()) {
      return done(
        'not-merged',
        `"${into}" is checked out and its working tree has local changes; fetched to ${ref} but not merged.`
      )
    }
  }

  if (intoSha) {
    // No `allowFailure`: the exit code *is* the answer, so the rejection is read.
    const fastForward = await git(['merge-base', '--is-ancestor', intoSha, sha]).then(() => true, () => false)
    if (!fastForward) {
      return done(
        'not-merged',
        `"${into}" has commits that are not in ${environment.name}'s "${branch}", so it cannot be fast-forwarded. `
        + `The environment's branch is at ${ref}; merge or rebase it yourself.`
      )
    }
  }

  if (checkedOut) await git(['merge', '--ff-only', '--quiet', ref])
  else await git(['update-ref', `refs/heads/${into}`, sha, ...(intoSha ? [intoSha] : [''])])
  return done(intoSha ? 'fast-forwarded' : 'created')
}
