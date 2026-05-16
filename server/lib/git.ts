/**
 * Git helpers — thin, injection-safe wrappers around `git` run against an
 * env's worktree on the host. We always use `execFile` with an argv array
 * (never a shell string) and a `--` separator before any path, so a file
 * named `--foo` or `; rm -rf` is just a file name.
 *
 * The worktree is a host-side directory, so these run on the same machine
 * as Domo (not inside the Coast container). Matches the design's
 * "commits run on the host" decision.
 */
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message)
    this.name = 'GitError'
  }
}

async function git(worktree: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['-C', worktree, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new GitError(
      (err.stderr || err.message || 'git failed').trim(),
      err.stderr ?? '',
    )
  }
}

export interface StatusEntry {
  path: string
  /** Original path for renames/copies. */
  origPath?: string
  /** Index (staged) status char: one of M A D R C U or ' '. */
  index: string
  /** Worktree (unstaged) status char. */
  worktree: string
}

export interface GitStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** Files with index-side changes (staged). */
  staged: StatusEntry[]
  /** Tracked files with worktree-side changes (unstaged). */
  unstaged: StatusEntry[]
  /** Untracked files. */
  untracked: StatusEntry[]
}

/**
 * Parse `git status --porcelain=v1 -z --branch`. With `-z`, records are
 * NUL-separated and unquoted; rename/copy records carry the original path
 * as the *next* record, so we consume it inline.
 */
export async function gitStatus(worktree: string): Promise<GitStatus> {
  const out = await git(worktree, ['status', '--porcelain=v1', '-z', '--branch'])
  const records = out.split('\0')

  const result: GitStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
  }

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue

    if (rec.startsWith('## ')) {
      const info = rec.slice(3)
      const noCommits = info.match(/^No commits yet on (.+)$/)
      if (noCommits) {
        result.branch = noCommits[1]!.trim()
        continue
      }
      const m = info.match(/^(.+?)(?:\.\.\.(\S+))?(?:\s\[(.+)\])?$/)
      if (m) {
        result.branch = m[1] === 'HEAD (no branch)' ? null : m[1]!
        result.upstream = m[2] ?? null
        const tracking = m[3] ?? ''
        const a = tracking.match(/ahead (\d+)/)
        const b = tracking.match(/behind (\d+)/)
        if (a) result.ahead = Number(a[1])
        if (b) result.behind = Number(b[1])
      }
      continue
    }

    const index = rec[0]!
    const worktreeChar = rec[1]!
    const path = rec.slice(3)
    const entry: StatusEntry = { path, index, worktree: worktreeChar }

    if (index === 'R' || index === 'C') {
      // The original path is the next NUL-separated record.
      entry.origPath = records[++i] ?? undefined
    }

    if (index === '?' && worktreeChar === '?') {
      result.untracked.push(entry)
      continue
    }
    if (index !== ' ' && index !== '?') result.staged.push(entry)
    if (worktreeChar !== ' ' && worktreeChar !== '?') result.unstaged.push(entry)
  }

  return result
}

/**
 * Contents of `path` at `ref` (`HEAD`, `:` for the index, a sha, …) or
 * `null` if the blob doesn't exist there. The `ref:path` colon form is a
 * single argv token, so there's no shell-quoting concern.
 */
export async function gitShow(
  worktree: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    return await git(worktree, ['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

/**
 * Worktree-relative paths git considers relevant: tracked files plus
 * untracked-but-not-ignored files (`.gitignore` honored, same set the
 * file tree shows). Powers the `@`-mention file/folder index. Empty on a
 * non-repo / error rather than throwing.
 */
export async function gitListPaths(worktree: string): Promise<string[]> {
  try {
    const out = await git(worktree, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ])
    const seen = new Set<string>()
    for (const p of out.split('\0')) {
      if (p) seen.add(p)
    }
    return [...seen]
  } catch {
    return []
  }
}

/** Recent commits (newest first) for the `@`-mention picker. */
export async function gitRecentCommits(
  worktree: string,
  limit: number,
): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const out = await git(worktree, [
      'log',
      `-n${Math.max(1, Math.min(limit, 100))}`,
      '--no-color',
      '--pretty=format:%h%x00%s',
    ])
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split('\0')
        return { sha: sha ?? '', subject: subject ?? '' }
      })
      .filter((c) => c.sha)
  } catch {
    return []
  }
}

/**
 * Combined uncommitted diff vs HEAD (staged + unstaged). Falls back to a
 * plain `git diff` on a repo with no commits yet. Used by `@git-changes`
 * prompt-mention expansion.
 */
export async function gitDiffWorking(worktree: string): Promise<string> {
  try {
    return await git(worktree, ['diff', '--no-color', 'HEAD'])
  } catch {
    try {
      return await git(worktree, ['diff', '--no-color'])
    } catch {
      return ''
    }
  }
}

/**
 * `git show` for a commit-ish (message + stat + patch, no color). `null`
 * if the ref doesn't resolve. Used by `@<sha>` prompt-mention expansion.
 * `sha` is passed as a single argv token (no shell), so it's safe.
 */
export async function gitShowCommit(
  worktree: string,
  sha: string,
): Promise<string | null> {
  try {
    return await git(worktree, [
      'show',
      '--no-color',
      '--stat',
      '--patch',
      sha,
    ])
  } catch {
    return null
  }
}

/**
 * Of `relPaths` (worktree-relative), return the set that `.gitignore` (or
 * any standard exclude) ignores. `git check-ignore` exits 1 when nothing
 * matched — that's success with an empty set, not an error.
 */
export async function gitCheckIgnore(
  worktree: string,
  relPaths: string[],
): Promise<Set<string>> {
  if (relPaths.length === 0) return new Set()
  return await new Promise((resolveP, rejectP) => {
    const child = execFileCb(
      'git',
      ['-C', worktree, 'check-ignore', '--stdin', '-z'],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const code = (err as { code?: number } | null)?.code
        if (err && code !== 1) {
          rejectP(new GitError((err.message || 'check-ignore failed').trim(), ''))
          return
        }
        resolveP(new Set(stdout.split('\0').filter(Boolean)))
      },
    )
    child.stdin?.end(relPaths.join('\0'))
  })
}

export async function gitStage(worktree: string, path: string): Promise<void> {
  await git(worktree, ['add', '--', path])
}

export async function gitUnstage(worktree: string, path: string): Promise<void> {
  // `reset HEAD` is the normal path; on an unborn branch (no HEAD yet) the
  // only way to unstage an added file is `rm --cached`.
  try {
    await git(worktree, ['reset', '-q', 'HEAD', '--', path])
  } catch {
    await git(worktree, ['rm', '-q', '--cached', '--', path])
  }
}

export async function gitCommit(
  worktree: string,
  message: string,
): Promise<{ hash: string }> {
  await git(worktree, ['commit', '-m', message])
  const hash = (await git(worktree, ['rev-parse', '--short', 'HEAD'])).trim()
  return { hash }
}

export async function gitPush(worktree: string): Promise<{ output: string }> {
  // `git push` writes progress to stderr even on success; surface stdout
  // and let GitError carry stderr on real failures.
  const out = await git(worktree, ['push'])
  return { output: out.trim() }
}
