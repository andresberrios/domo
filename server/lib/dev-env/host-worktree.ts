import { access, copyFile, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { RepositoryState, WorkspaceSeedReport } from '../../../shared/types'
import { canonicalGitdirFileContents } from './canonical-mounts'
import { run } from './docker'
import { DEFAULT_COPY_IGNORED, matchesAny, readHostWorkingTree } from './workspace-seed'

/**
 * The environment's checkout, as a linked git worktree on the host rather
 * than a tar-copied volume.
 *
 * `git worktree add` puts only *tracked* files on disk — no `node_modules`,
 * `.venv` or anything else ignored — and shares the project's object database
 * instead of duplicating it. The tar copy it replaces moved every ignored
 * dependency tree into every environment, which was both the create/delete
 * cost and, measured, a source of wrong-platform native binaries.
 *
 * A worktree starts clean at the commit it was cut from, as git users expect:
 * nothing uncommitted comes along. The ignored files a checkout needs to run
 * (a `.env`) are copied by pattern (`copyIgnored`).
 *
 * Every worktree is **locked**. Environments see the whole base `.git`,
 * including every sibling's admin directory, whose `gitdir` names a host path
 * that does not exist in the container — so an unlocked one is exactly what a
 * `git worktree prune` (or `gc`'s own) run inside any environment deletes.
 * Measured: prune skips a locked entry whose directory is missing.
 */

export const WORKTREES_DIRNAME = '.domo-worktrees'
const GITDIR_SUFFIX = '.container-gitdir'
const LOCK_REASON = 'Domo development environment; retire it from Domo instead of removing it here.'

/** The directory every worktree of a checkout's siblings lives in. */
export function worktreesRoot(repoPath: string): string {
  return join(dirname(resolve(repoPath)), WORKTREES_DIRNAME)
}

/** Where an environment's worktree lives on the host: a sibling of the project's checkout, never inside it. */
export function hostWorktreePath(repoPath: string, environmentId: string): string {
  return join(worktreesRoot(repoPath), environmentId)
}

/**
 * The container-only `.git` override for one worktree: a side file, never the
 * worktree's own `.git`. `container.ts` bind-mounts it *over*
 * `<canonical workspace>/.git`, so the container sees a `gitdir:` that
 * resolves in its own mount namespace while the host's file stays valid.
 * Measured: rewriting the worktree's own `.git` to a path the host does not
 * have makes `git worktree remove --force` refuse with "not a .git file".
 */
export function containerGitdirFilePath(repoPath: string, environmentId: string): string {
  return join(worktreesRoot(repoPath), `${environmentId}${GITDIR_SUFFIX}`)
}

/**
 * The project's real `.git` directory — the one every worktree's admin
 * directory lives in. Not `<repoPath>/.git`: when the project checkout is
 * itself a linked worktree, that is a file.
 */
export async function hostCommonGitDir(repoPath: string): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  return stdout.trim()
}

/** The worktree's admin directory relative to the common `.git`, as git actually named it. */
export async function worktreeAdminPath(worktreePath: string, commonGitDir: string): Promise<string> {
  const pointer = (await readFile(join(worktreePath, '.git'), 'utf8')).trim()
  const match = /^gitdir:\s*(.+)$/.exec(pointer)
  if (!match) throw new Error(`${worktreePath}/.git is not a worktree pointer.`)
  const admin = relative(commonGitDir, resolve(worktreePath, match[1]!))
  if (!admin || admin.startsWith('..') || isAbsolute(admin)) {
    throw new Error(`${worktreePath}'s admin directory is not inside ${commonGitDir}.`)
  }
  return admin.split(sep).join('/')
}

async function headExists(repoPath: string): Promise<boolean> {
  const head = await run('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true })
    .catch(() => ({ stdout: '' }))
  return !!head.stdout.trim()
}

/**
 * Ignored files of the host checkout that match `globs`, relative to it.
 * `--directory` collapses an ignored directory into one entry, so a
 * `node_modules` is one line to skip rather than tens of thousands to read.
 */
export async function ignoredFilesToCopy(repoPath: string, globs: string[]): Promise<string[]> {
  if (!globs.length) return []
  const { stdout } = await run('git', [
    '-C', repoPath, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'
  ], { trimOutput: false })
  return stdout.split('\0').filter(path => path && !path.endsWith('/') && matchesAny(path, globs))
}

export interface CreateHostWorktreeInput {
  repoPath: string
  projectId: string
  environmentId: string
  /** Globs of ignored files to copy in; `DEFAULT_COPY_IGNORED` when absent, nothing when empty. */
  copyIgnored?: string[]
}

export interface CreateHostWorktreeResult {
  worktreePath: string
  gitdirFilePath: string
  /** The project's real `.git`, which the container mounts at `canonicalBaseGitPath`. */
  commonGitDir: string
  seed: Pick<WorkspaceSeedReport, 'paths' | 'copied'>
}

/**
 * Create the environment's worktree, locked, its container-only `.git`
 * override, and copies of the ignored files that match `copyIgnored`. A
 * failure after `worktree add` is the caller's to clean up, like every other
 * resource a failed creation made.
 */
export async function createHostWorktree(input: CreateHostWorktreeInput): Promise<CreateHostWorktreeResult> {
  if (!(await headExists(input.repoPath))) {
    throw new Error(
      `${input.repoPath} has no commits yet, so a worktree cannot be cut from it. `
      + 'Create the first commit (Domo offers to when you create an environment) and try again.'
    )
  }
  const dirtyPaths = await readHostWorkingTree(input.repoPath)
  const commonGitDir = await hostCommonGitDir(input.repoPath)
  const worktreePath = hostWorktreePath(input.repoPath, input.environmentId)
  const gitdirFilePath = containerGitdirFilePath(input.repoPath, input.environmentId)
  await mkdir(dirname(worktreePath), { recursive: true })
  await run('git', [
    '-C', input.repoPath, 'worktree', 'add', '--detach', '--lock', '--reason', LOCK_REASON, worktreePath, 'HEAD'
  ])
  const adminPath = await worktreeAdminPath(worktreePath, commonGitDir)
  await writeFile(gitdirFilePath, canonicalGitdirFileContents(input.projectId, adminPath), 'utf8')

  const copied = await ignoredFilesToCopy(input.repoPath, input.copyIgnored ?? DEFAULT_COPY_IGNORED)
  for (const path of copied) {
    await mkdir(dirname(join(worktreePath, path)), { recursive: true })
    await copyFile(join(input.repoPath, path), join(worktreePath, path))
  }
  return { worktreePath, gitdirFilePath, commonGitDir, seed: { paths: dirtyPaths, copied } }
}

/**
 * Remove an environment's worktree and its `.git` override, and say what is
 * still there afterwards — decided by looking, not by an exit code, as the
 * Docker sweep does.
 *
 * `remove --force --force` because the worktree is locked. Measured: it also
 * clears the entry when the directory is already gone. Never `git worktree
 * prune`: it is repository-wide, and on the developer's own checkout it drops
 * entries for worktrees that have nothing to do with Domo (measured: a dry run
 * here listed two of the developer's own).
 */
export async function removeHostWorktree(input: { repoPath: string, environmentId: string }): Promise<string[]> {
  const worktreePath = hostWorktreePath(input.repoPath, input.environmentId)
  const gitdirFilePath = containerGitdirFilePath(input.repoPath, input.environmentId)
  const registration = await domoRegistration(input.repoPath, worktreePath)
  if (registration === 'foreign' || (registration === 'none' && await exists(worktreePath))) {
    throw new NotDomosWorktreeError(worktreePath)
  }
  if (registration === 'domo') {
    await run('git', ['-C', input.repoPath, 'worktree', 'remove', '--force', '--force', worktreePath], { allowFailure: true })
      .catch(() => null)
    await rm(worktreePath, { recursive: true, force: true }).catch(() => null)
  }
  const pointer = await readFile(gitdirFilePath, 'utf8').catch(() => null)
  if (pointer?.startsWith('gitdir: /worktrees/.base/')) await rm(gitdirFilePath, { force: true }).catch(() => null)
  const left: string[] = []
  for (const path of [worktreePath, gitdirFilePath]) if (await exists(path)) left.push(path)
  return left
}

const exists = (path: string) => access(path).then(() => true, () => false)

/** A path that is claimed but is not the worktree Domo made there. Never removed; said. */
export class NotDomosWorktreeError extends Error {
  constructor(path: string) {
    super(
      `${path} is not the locked worktree Domo made for this environment, so it was left alone. `
      + 'If it is not yours, remove it and run the cleanup again.'
    )
  }
}

/** A path as git records it: symlinks in its existing part resolved (macOS's /var is /private/var). */
async function canonicalPath(path: string): Promise<string> {
  const real = await realpath(path).catch(() => null)
  if (real) return real
  const parent = await realpath(dirname(path)).catch(() => dirname(path))
  return join(parent, basename(path))
}

/**
 * Whether git has a worktree registered at `path`, and whether it is Domo's:
 * locked with Domo's own reason, as `createHostWorktree` makes every one.
 * Something else there — the developer's own worktree, a directory nobody
 * registered — is never force-removed on a row's say-so.
 */
async function domoRegistration(repoPath: string, path: string): Promise<'domo' | 'foreign' | 'none'> {
  const target = await canonicalPath(path)
  const listed = await run('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], { allowFailure: true })
    .catch(() => ({ stdout: '' }))
  for (const block of listed.stdout.split('\n\n')) {
    const lines = block.split('\n')
    const worktree = lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length)
    if (!worktree || await canonicalPath(worktree) !== target) continue
    return lines.includes(`locked ${LOCK_REASON}`) ? 'domo' : 'foreign'
  }
  return 'none'
}

/** Whether a worktree is on disk for this environment — the observation the leftover sweep decides on. */
export function hostWorktreeExists(repoPath: string, environmentId: string): Promise<boolean> {
  return exists(hostWorktreePath(repoPath, environmentId))
}

/** Environment ids that have a worktree beside this checkout, whether or not any row knows them. */
export async function listHostWorktrees(repoPath: string): Promise<string[]> {
  const entries = await readdir(worktreesRoot(repoPath), { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/** Whether the checkout can have a worktree cut from it, and what a first commit would hold. */
export async function repositoryState(repoPath: string): Promise<RepositoryState> {
  const isRepository = await stat(join(repoPath, '.git')).then(() => true, () => false)
  if (!isRepository) return { repository: false, hasCommits: false, filesToCommit: null }
  if (await headExists(repoPath)) return { repository: true, hasCommits: true, filesToCommit: null }
  const { stdout } = await run('git', ['-C', repoPath, 'ls-files', '--others', '--cached', '--exclude-standard', '-z'], { trimOutput: false })
  return { repository: true, hasCommits: false, filesToCommit: stdout.split('\0').filter(Boolean).length }
}

/**
 * Make the checkout ready for worktrees: initialise it if it is not a
 * repository, and commit everything `.gitignore` allows as the first commit.
 * Refuses a repository that already has a commit — nothing is ever committed
 * on top of the developer's own history.
 */
export async function createInitialCommit(repoPath: string): Promise<string> {
  const state = await repositoryState(repoPath)
  if (state.hasCommits) throw new Error('This project already has commits.')
  if (!state.repository) await run('git', ['-C', repoPath, 'init', '--quiet'])
  await run('git', ['-C', repoPath, 'add', '--all'])
  const identity: string[] = []
  const email = await run('git', ['-C', repoPath, 'config', 'user.email'], { allowFailure: true })
  if (!email.stdout.trim()) identity.push('-c', 'user.email=domo@localhost')
  const name = await run('git', ['-C', repoPath, 'config', 'user.name'], { allowFailure: true })
  if (!name.stdout.trim()) identity.push('-c', 'user.name=Domo')
  await run('git', [...identity, '-C', repoPath, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'Initial commit'])
  return (await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim()
}
