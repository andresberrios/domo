import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DevEnvironment } from '../../shared/types'
import { run } from '../../server/lib/dev-env/docker'
import { exportBranch, importBranch } from '../../server/lib/dev-env/git-sync'
import { createDevEnvironmentRow, createProject } from '../../server/lib/repo'

/**
 * The whole export *and* the whole import, with real git on both ends and no
 * Docker.
 *
 * The transport is the only injected part: in production it is
 * `ext::docker exec … %S <workspace>`, here it is `ext::%S <directory>`
 * against a second checkout. `%S` is doing the same job in both — it is what
 * lets one URL serve `git-upload-pack` for the fetch and `git-receive-pack`
 * for the push. Everything else — the negotiation, the tracking ref, the
 * fast-forward rules, the checked-out-branch refusal and the
 * environment/project lookup in Postgres — is the real thing.
 */

const scratch: string[] = []
let counter = 0
let host: string
let container: string
let environment: DevEnvironment

/** The service git asks for, straight against a directory: the same transport, without a container. */
const transport = () => `ext::%S ${container}`

async function git(repo: string, ...args: string[]) {
  return run('git', [
    '-C', repo,
    '-c', 'user.name=Domo Test',
    '-c', 'user.email=test@example.com',
    '-c', 'commit.gpgsign=false',
    ...args
  ])
}

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `domo-git-sync-${prefix}-`))
  scratch.push(path)
  return path
}

async function commit(repo: string, name: string, message: string) {
  await writeFile(join(repo, name), `${message}\n`, 'utf8')
  await git(repo, 'add', name)
  await git(repo, 'commit', '--quiet', '-m', message)
  return (await git(repo, 'rev-parse', 'HEAD')).stdout
}

const revision = async (repo: string, ref: string): Promise<string | null> =>
  (await run('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', ref], { allowFailure: true })).stdout || null

const subjects = (result: { commits: Array<{ subject: string }> }) => result.commits.map(entry => entry.subject)

beforeEach(async () => {
  host = await temp('host')
  await run('git', ['init', '--quiet', '--initial-branch=main', host])
  await commit(host, 'README.md', 'first')

  // What an environment's volume holds: a copy of the project's checkout.
  container = await temp('container')
  await run('git', ['clone', '--quiet', host, container])
  await git(container, 'checkout', '--quiet', '-b', 'feature')

  const project = await createProject({ name: 'domo', repoPath: host })
  environment = await createDevEnvironmentRow({
    projectId: project.id,
    name: 'Feature Auth',
    containerName: `domo-dev-env_${++counter}`,
    workspacePath: '/workspaces/feature-auth',
    remoteUser: 'vscode'
  })
})

afterEach(async () => {
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true })
})

/**
 * `into` is taken literally here — an absent one means "fetch only". Defaulting
 * it to the branch's own name is the API's job (`resolveIntoBranch`), so the
 * tests below name it every time they mean it.
 */
const exportIt = (branch: string, into: string | null = branch) =>
  exportBranch({ environmentId: environment.id, branch, into, transport })

describe('exporting a branch from an environment', () => {
  it('fetches into the environment\'s own tracking namespace and creates the local branch', async () => {
    const sha = await commit(container, 'feature.txt', 'work in the environment')

    const result = await exportIt('feature')

    expect(result).toMatchObject({
      // The name is the environment's, made safe, so two environments of one
      // project never collide.
      ref: 'refs/remotes/domo-env/feature-auth/feature',
      sha,
      into: 'feature',
      result: 'created'
    })
    expect(subjects(result)).toEqual(['work in the environment'])
    await expect(revision(host, 'refs/heads/feature')).resolves.toBe(sha)
    await expect(revision(host, 'refs/remotes/domo-env/feature-auth/feature')).resolves.toBe(sha)
  })

  it('fast-forwards a local branch that is behind, and lists only what is new', async () => {
    await commit(container, 'feature.txt', 'first commit')
    await exportIt('feature')
    const sha = await commit(container, 'feature.txt', 'second commit')

    const result = await exportIt('feature')

    expect(result).toMatchObject({ result: 'fast-forwarded', sha })
    expect(subjects(result)).toEqual(['second commit'])
    await expect(revision(host, 'refs/heads/feature')).resolves.toBe(sha)
  })

  it('says up-to-date, with nothing to list, when the export is a repeat', async () => {
    await commit(container, 'feature.txt', 'only commit')
    await exportIt('feature')

    const result = await exportIt('feature')

    expect(result).toMatchObject({ result: 'up-to-date', commits: [] })
  })

  it('fetches without touching a local branch when none is named', async () => {
    const sha = await commit(container, 'feature.txt', 'work in the environment')

    // No `into` at all is the same thing as an explicit null.
    const result = await exportBranch({ environmentId: environment.id, branch: 'feature', transport })

    expect(result).toMatchObject({ into: null, result: 'not-merged' })
    expect(result.reason).toMatch(/No local branch was named/)
    expect(subjects(result)).toEqual(['work in the environment'])
    await expect(revision(host, 'refs/remotes/domo-env/feature-auth/feature')).resolves.toBe(sha)
    await expect(revision(host, 'refs/heads/feature')).resolves.toBeNull()
  })

  it('refuses to move a local branch that has diverged, and says so', async () => {
    await commit(container, 'feature.txt', 'in the environment')
    await git(host, 'branch', 'feature')
    await git(host, 'checkout', '--quiet', 'feature')
    const local = await commit(host, 'local.txt', 'on the host')
    await git(host, 'checkout', '--quiet', 'main')

    const result = await exportIt('feature')

    expect(result.result).toBe('not-merged')
    expect(result.reason).toMatch(/cannot be fast-forwarded/)
    // Never force, never merge, never rebase: the host's own commit survives.
    await expect(revision(host, 'refs/heads/feature')).resolves.toBe(local)
    await expect(revision(host, 'refs/remotes/domo-env/feature-auth/feature')).resolves.toBe(result.sha)
  })

  it('moves the checked-out branch with a real merge, so the working tree follows', async () => {
    await git(container, 'checkout', '--quiet', 'main')
    const sha = await commit(container, 'shipped.txt', 'shipped from the environment')

    const result = await exportIt('main')

    expect(result).toMatchObject({ result: 'fast-forwarded', into: 'main' })
    await expect(revision(host, 'HEAD')).resolves.toBe(sha)
    await expect(run('git', ['-C', host, 'status', '--porcelain'])).resolves.toMatchObject({ stdout: '' })
  })

  it('leaves the checked-out branch alone when its working tree is dirty', async () => {
    await git(container, 'checkout', '--quiet', 'main')
    const before = await revision(host, 'HEAD')
    await commit(container, 'shipped.txt', 'shipped from the environment')
    await writeFile(join(host, 'README.md'), 'edited on the host\n', 'utf8')

    const result = await exportIt('main')

    expect(result.result).toBe('not-merged')
    expect(result.reason).toMatch(/working tree has local changes/)
    await expect(revision(host, 'HEAD')).resolves.toBe(before)
  })

  it('fast-forwards a differently named local branch without checking anything out', async () => {
    const sha = await commit(container, 'feature.txt', 'work in the environment')
    await git(host, 'branch', 'review')

    const result = await exportIt('feature', 'review')

    expect(result).toMatchObject({ result: 'fast-forwarded', into: 'review' })
    await expect(revision(host, 'refs/heads/review')).resolves.toBe(sha)
    // main is still checked out and untouched.
    await expect(run('git', ['-C', host, 'symbolic-ref', '--short', 'HEAD'])).resolves.toMatchObject({ stdout: 'main' })
  })

  it('follows a branch the environment rewrote, because the tracking ref is not a local branch', async () => {
    await commit(container, 'feature.txt', 'before the amend')
    await exportIt('feature', null)
    await git(container, 'commit', '--quiet', '--amend', '-m', 'after the amend')
    const amended = (await git(container, 'rev-parse', 'HEAD')).stdout

    const result = await exportIt('feature', null)

    expect(result.sha).toBe(amended)
    await expect(revision(host, 'refs/remotes/domo-env/feature-auth/feature')).resolves.toBe(amended)
  })

  it('names the branch it could not find, rather than reporting a git failure', async () => {
    await expect(exportIt('nope')).rejects.toThrow(/Feature Auth has no branch called "nope"/)
  })

  it('refuses a branch name git would read as something else', async () => {
    await expect(exportIt('--upload-pack=touch')).rejects.toThrow(/not a valid branch name/)
    await expect(exportIt('feature', 'a b')).rejects.toThrow(/not a valid branch name/)
  })

  it('fails readably when the environment or its project is gone', async () => {
    await expect(exportBranch({ environmentId: 'env_missing', branch: 'main', transport }))
      .rejects.toThrow(/Development environment not found/)
  })
})

/**
 * `from` defaults to the branch's own name (`resolveFromRef`), which is the
 * common case; the tests below name it only where they mean something else.
 */
const importIt = (branch: string, from?: string) =>
  importBranch({ environmentId: environment.id, branch, from, transport })

describe('importing a branch into an environment', () => {
  it('creates a branch the environment does not have yet, and lists what crossed', async () => {
    await git(host, 'checkout', '--quiet', '-b', 'release')
    const sha = await commit(host, 'release.txt', 'cut the release')

    const result = await importIt('release')

    expect(result).toMatchObject({ branch: 'release', from: 'release', sha, result: 'created' })
    expect(subjects(result)).toEqual(['cut the release'])
    await expect(revision(container, 'refs/heads/release')).resolves.toBe(sha)
  })

  // The case this was built for: work lands on the host and four environments
  // are left sitting on a stale main.
  it('fast-forwards a branch the environment is behind on', async () => {
    const sha = await commit(host, 'landed.txt', 'landed on the host')

    const result = await importIt('main')

    expect(result).toMatchObject({ result: 'fast-forwarded', sha })
    expect(subjects(result)).toEqual(['landed on the host'])
    await expect(revision(container, 'refs/heads/main')).resolves.toBe(sha)
  })

  it('says up-to-date, with nothing to list, when the import is a repeat', async () => {
    await commit(host, 'landed.txt', 'landed on the host')
    await importIt('main')

    const result = await importIt('main')

    expect(result).toMatchObject({ result: 'up-to-date', commits: [] })
  })

  it('sends a differently named host ref into a branch of its own', async () => {
    const sha = await commit(host, 'staged.txt', 'for review')

    const result = await importIt('staging', 'main')

    expect(result).toMatchObject({ branch: 'staging', from: 'main', result: 'created', sha })
    await expect(revision(container, 'refs/heads/staging')).resolves.toBe(sha)
    // The environment's own main was not the target and did not move.
    await expect(revision(container, 'refs/heads/main')).resolves.not.toBe(sha)
  })

  /**
   * The one that destroys work rather than merely annoying someone. The
   * environment's working tree and index belong to its checked-out branch and
   * may hold an agent's uncommitted changes; moving the ref under it strands
   * them. `receive.denyCurrentBranch` would refuse too, but it is a default
   * somebody can turn off, so this is checked before anything is sent.
   */
  it('refuses the branch the environment has checked out, and sends nothing', async () => {
    const before = await revision(container, 'refs/heads/feature')
    await git(host, 'checkout', '--quiet', '-b', 'feature')
    await commit(host, 'feature.txt', 'on the host')

    const result = await importIt('feature')

    expect(result.result).toBe('not-merged')
    expect(result.reason).toMatch(/has "feature" checked out/)
    expect(result.commits).toEqual([])
    await expect(revision(container, 'refs/heads/feature')).resolves.toBe(before)
  })

  it('refuses a branch the environment has moved on its own, and says where to look', async () => {
    await git(container, 'checkout', '--quiet', 'main')
    const inTheEnvironment = await commit(container, 'agent.txt', 'the agent\'s own commit')
    await git(container, 'checkout', '--quiet', 'feature')
    await commit(host, 'landed.txt', 'landed on the host')

    const result = await importIt('main')

    expect(result.result).toBe('not-merged')
    expect(result.reason).toMatch(/cannot be fast-forwarded/)
    // Never force, never merge, never rebase: the agent's commit survives.
    await expect(revision(container, 'refs/heads/main')).resolves.toBe(inTheEnvironment)
    expect(result.sha).toBe(inTheEnvironment)
  })

  it('names what it could not find in the project\'s checkout', async () => {
    await expect(importIt('main', 'nope')).rejects.toThrow(/nothing called "nope" to send/)
  })

  it('refuses a branch name git would read as something else', async () => {
    await expect(importIt('--receive-pack=touch')).rejects.toThrow(/not a valid branch name/)
    await expect(importIt('main', 'a b')).rejects.toThrow(/not a valid branch name/)
  })

  it('fails readably when the environment or its project is gone', async () => {
    await expect(importBranch({ environmentId: 'env_missing', branch: 'main', transport }))
      .rejects.toThrow(/Development environment not found/)
  })
})

/**
 * The point of `%S`: one URL, both services. If the transport were still
 * hard-coded to `git-upload-pack` this would fail on the push half with
 * `bad line length character`, which is the failure the substitution exists to
 * avoid and the one nobody should have to diagnose twice.
 */
describe('one transport, both directions', () => {
  it('takes a branch out of an environment and back into it', async () => {
    const sha = await commit(container, 'feature.txt', 'work in the environment')

    await expect(exportIt('feature')).resolves.toMatchObject({ result: 'created' })

    // The host now has it, moves it on, and sends it to a branch the
    // environment is not sitting on.
    await git(host, 'checkout', '--quiet', 'feature')
    const reviewed = await commit(host, 'review.txt', 'reviewed on the host')
    await git(host, 'checkout', '--quiet', 'main')

    const result = await importIt('feature-reviewed', 'feature')

    expect(result).toMatchObject({ result: 'created', sha: reviewed })
    expect(subjects(result)).toEqual(['reviewed on the host'])
    await expect(revision(container, 'refs/heads/feature-reviewed')).resolves.toBe(reviewed)
    // The branch the environment is working on was not touched by either leg.
    await expect(revision(container, 'refs/heads/feature')).resolves.toBe(sha)
  })
})
