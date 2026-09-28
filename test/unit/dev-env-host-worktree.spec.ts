import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { canonicalGitdirFileContents } from '../../server/lib/dev-env/canonical-mounts'
import {
  createHostWorktree,
  createInitialCommit,
  hostCommonGitDir,
  removeHostWorktree,
  repositoryState,
  worktreeAdminPath
} from '../../server/lib/dev-env/host-worktree'

/**
 * Against real git, in a scratch repository: the worktree an environment gets,
 * the `.git` the container sees, and what cleanup does and does not touch.
 * The mounts themselves are argv, pinned in `dev-env-container.spec.ts`.
 */

const exec = promisify(execFile)
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-C', cwd, ...args])).stdout.trim()
const exists = (path: string) => access(path).then(() => true, () => false)

// The developer's own git config (signing, hooks, identity) must not decide
// whether these pass.
const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = saved.global
  if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = saved.system
})

let root: string
let repo: string

beforeEach(async () => {
  // Real path: git reports /private/var for macOS's /var.
  root = await realpath(await mkdtemp(join(tmpdir(), 'domo-wt-')))
  repo = join(root, 'repo')
  await mkdir(join(repo, 'node_modules', 'pkg'), { recursive: true })
  await git(repo, 'init', '--quiet', '-b', 'main')
  await git(repo, 'config', 'user.email', 'dev@example.test')
  await git(repo, 'config', 'user.name', 'Dev')
  await writeFile(join(repo, 'a.txt'), 'committed\n')
  await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env\n')
  await writeFile(join(repo, '.env'), 'SECRET=1\n')
  await writeFile(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  await git(repo, 'add', 'a.txt', '.gitignore')
  await git(repo, 'commit', '--quiet', '-m', 'initial')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const create = (copyIgnored?: string[], environmentId = 'env_1', branch = environmentId) => createHostWorktree({
  repoPath: repo,
  projectId: 'prj_1',
  environmentId,
  branch,
  copyIgnored
})

describe('createHostWorktree', () => {
  it('cuts a clean worktree beside the checkout, with no dependency tree and none of the host\'s edits', async () => {
    await writeFile(join(repo, 'a.txt'), 'edited on the host\n')
    await writeFile(join(repo, 'b.txt'), 'untracked\n')

    const result = await create()

    expect(result.worktreePath).toBe(join(root, '.domo-worktrees', 'env_1'))
    expect(await readFile(join(result.worktreePath, 'a.txt'), 'utf8')).toBe('committed\n')
    for (const absent of ['node_modules', 'b.txt']) {
      expect(await exists(join(result.worktreePath, absent)), absent).toBe(false)
    }
    expect(result.seed).toEqual({ paths: ['a.txt', 'b.txt'], copied: ['.env'] })
    // Only ever read: the host keeps its edit.
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('edited on the host\n')
  })

  it('works on a branch named for the environment, so its commits outlive the worktree', async () => {
    const { worktreePath } = await create(undefined, 'env_1', 'feature-auth')
    expect(await git(worktreePath, 'symbolic-ref', '--short', 'HEAD')).toBe('feature-auth')
    expect(await git(repo, 'rev-parse', 'feature-auth')).toBe(await git(repo, 'rev-parse', 'HEAD'))

    await git(worktreePath, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'agent work')
    expect(await removeHostWorktree({ repoPath: repo, environmentId: 'env_1' })).toEqual([])
    expect(await git(repo, 'log', '-1', '--format=%s', 'feature-auth')).toBe('agent work')
  })

  it('continues on a branch that already exists, and refuses one checked out elsewhere', async () => {
    await git(repo, 'branch', 'existing')
    await git(repo, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'after the branch')
    const { worktreePath } = await create(undefined, 'env_1', 'existing')
    expect(await git(worktreePath, 'log', '-1', '--format=%s')).toBe('initial')

    await expect(create(undefined, 'env_2', 'existing')).rejects.toThrow(/Could not check out the branch existing/)
    await expect(create(undefined, 'env_3', 'main')).rejects.toThrow(/Could not check out the branch main/)
    await expect(create(undefined, 'env_4', 'bad..name')).rejects.toThrow(/cannot be a git branch name/)
    expect(await exists(join(root, '.domo-worktrees', 'env_4'))).toBe(false)
  })

  it('locks the worktree, so a prune run anywhere that cannot see its directory leaves it alone', async () => {
    const { worktreePath } = await create()

    const listing = await git(repo, 'worktree', 'list', '--porcelain')
    expect(listing).toMatch(new RegExp(`worktree ${worktreePath}\\n[\\s\\S]*?locked Domo development environment`))

    await rm(worktreePath, { recursive: true, force: true })
    await git(repo, 'worktree', 'prune')
    expect(await git(repo, 'worktree', 'list')).toContain(worktreePath)
  })

  it('writes the container\'s .git beside the worktree, and leaves the worktree\'s own .git valid for the host', async () => {
    const result = await create()
    const common = await hostCommonGitDir(repo)
    const admin = await worktreeAdminPath(result.worktreePath, common)

    expect(admin).toBe('worktrees/env_1')
    expect(await readFile(result.gitdirFilePath, 'utf8')).toBe(canonicalGitdirFileContents('prj_1', admin))
    expect(await readFile(join(result.worktreePath, '.git'), 'utf8')).toBe(`gitdir: ${join(common, admin)}\n`)
    expect(result.commonGitDir).toBe(common)
    expect(await git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'HEAD'))
  })

  it('works when the base .git is reached by another path, as the container mounts it, and writes land on the host', async () => {
    const result = await create()
    const common = await hostCommonGitDir(repo)
    const admin = await worktreeAdminPath(result.worktreePath, common)
    // The container's layout, with a symlink standing in for the bind mount:
    // the base under its canonical-shaped path, and a checkout whose `.git`
    // names only that path — never the host's.
    const base = join(root, 'container', '.base', 'prj_1')
    await mkdir(join(root, 'container', '.base'), { recursive: true })
    await symlink(common, base)
    const view = join(root, 'container', 'env_1')
    await mkdir(view)
    await writeFile(join(view, '.git'), `gitdir: ${join(base, admin)}\n`)

    expect(await git(view, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'HEAD'))
    await git(view, 'commit', '--quiet', '--allow-empty', '-m', 'from the container')
    expect(await git(result.worktreePath, 'log', '-1', '--format=%s')).toBe('from the container')
    // The host's own branch did not move.
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe('initial')
  })

  it('copies ignored .env files at any depth by default, and never an ignored directory', async () => {
    await mkdir(join(repo, 'apps', 'api'), { recursive: true })
    await writeFile(join(repo, 'apps', 'api', '.env'), 'NESTED=1\n')
    await writeFile(join(repo, 'node_modules', 'pkg', '.env'), 'INSIDE_DEPENDENCIES=1\n')

    const result = await create()

    expect(result.seed.copied.sort()).toEqual(['.env', 'apps/api/.env'])
    expect(await readFile(join(result.worktreePath, 'apps', 'api', '.env'), 'utf8')).toBe('NESTED=1\n')
    expect(await exists(join(result.worktreePath, 'node_modules'))).toBe(false)
    // Still ignored in the worktree: it can never reach an agent's commit.
    expect(await git(result.worktreePath, 'status', '--porcelain')).toBe('')
  })

  it('copies exactly what copyIgnored names, and nothing when it is empty', async () => {
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n.env\n*.pem\n')
    await git(repo, 'commit', '--quiet', '-am', 'ignore keys')
    await writeFile(join(repo, 'dev.pem'), 'key\n')

    expect((await create(['*.pem'], 'env_pem')).seed.copied).toEqual(['dev.pem'])
    expect((await create([], 'env_none')).seed.copied).toEqual([])
    expect(await exists(join(root, '.domo-worktrees', 'env_none', '.env'))).toBe(false)
  })

  it('refuses a checkout with no commits, before making anything', async () => {
    const empty = join(root, 'empty')
    await mkdir(empty)
    await git(empty, 'init', '--quiet')

    await expect(createHostWorktree({ repoPath: empty, projectId: 'prj_1', environmentId: 'env_1', branch: 'env_1' }))
      .rejects.toThrow(/has no commits yet/)
    expect(await exists(join(root, '.domo-worktrees'))).toBe(false)
  })
})

describe('repositoryState and createInitialCommit', () => {
  it('reports a checkout with commits as ready, and never commits on top of its history', async () => {
    expect(await repositoryState(repo)).toEqual({ repository: true, hasCommits: true, filesToCommit: null })
    await expect(createInitialCommit(repo)).rejects.toThrow(/already has commits/)
    expect(await git(repo, 'rev-list', '--count', 'HEAD')).toBe('1')
  })

  it('counts what the first commit would hold, respecting .gitignore, and makes it', async () => {
    const fresh = join(root, 'fresh')
    await mkdir(join(fresh, 'node_modules', 'pkg'), { recursive: true })
    await git(fresh, 'init', '--quiet')
    await writeFile(join(fresh, '.gitignore'), 'node_modules/\n')
    await writeFile(join(fresh, 'index.ts'), 'export {}\n')
    await writeFile(join(fresh, 'node_modules', 'pkg', 'index.js'), '\n')

    expect(await repositoryState(fresh)).toEqual({ repository: true, hasCommits: false, filesToCommit: 2 })
    await createInitialCommit(fresh)

    expect(await repositoryState(fresh)).toMatchObject({ hasCommits: true })
    expect((await git(fresh, 'ls-files')).split('\n').sort()).toEqual(['.gitignore', 'index.ts'])
    // And a worktree can now be cut from it.
    await expect(createHostWorktree({ repoPath: fresh, projectId: 'prj_2', environmentId: 'env_fresh', branch: 'fresh' })).resolves.toBeTruthy()
  })

  it('makes a plain folder a repository first', async () => {
    const plain = join(root, 'plain')
    await mkdir(plain)
    await writeFile(join(plain, 'README.md'), '# hi\n')

    expect(await repositoryState(plain)).toEqual({ repository: false, hasCommits: false, filesToCommit: null })
    await createInitialCommit(plain)
    expect(await git(plain, 'log', '--format=%s')).toBe('Initial commit')
  })
})

describe('removeHostWorktree', () => {
  it('removes the worktree and its .git override, and no other worktree\'s entry', async () => {
    // Somebody else's worktree whose directory is gone: exactly what a
    // repository-wide prune would take with it.
    const theirs = join(root, 'theirs')
    await git(repo, 'worktree', 'add', '--quiet', '--detach', theirs, 'HEAD')
    await rm(theirs, { recursive: true, force: true })
    const { worktreePath, gitdirFilePath } = await create()

    expect(await removeHostWorktree({ repoPath: repo, environmentId: 'env_1' })).toEqual([])

    const listing = await git(repo, 'worktree', 'list')
    expect(listing).not.toContain(worktreePath)
    expect(listing).toContain(theirs)
    expect(await exists(worktreePath)).toBe(false)
    expect(await exists(gitdirFilePath)).toBe(false)
  })

  it('clears the entry of a locked worktree whose directory is already gone', async () => {
    const { worktreePath } = await create()
    await rm(worktreePath, { recursive: true, force: true })

    expect(await removeHostWorktree({ repoPath: repo, environmentId: 'env_1' })).toEqual([])
    expect(await git(repo, 'worktree', 'list')).not.toContain(worktreePath)
  })

  it('refuses a directory at the claimed path that is not a worktree at all, and leaves it', async () => {
    const lookalike = join(root, '.domo-worktrees', 'env_1')
    await mkdir(lookalike, { recursive: true })
    await writeFile(join(lookalike, 'notes.md'), 'mine\n')

    await expect(removeHostWorktree({ repoPath: repo, environmentId: 'env_1' })).rejects.toThrow(/not the locked worktree Domo made/)
    expect(await readFile(join(lookalike, 'notes.md'), 'utf8')).toBe('mine\n')
  })

  it('refuses the developer\'s own worktree at the claimed path, and leaves both it and its entry', async () => {
    const theirs = join(root, '.domo-worktrees', 'env_1')
    await mkdir(join(root, '.domo-worktrees'), { recursive: true })
    await git(repo, 'worktree', 'add', '--quiet', '--detach', theirs, 'HEAD')
    await writeFile(join(theirs, 'wip.txt'), 'uncommitted\n')

    await expect(removeHostWorktree({ repoPath: repo, environmentId: 'env_1' })).rejects.toThrow(/left alone/)
    expect(await readFile(join(theirs, 'wip.txt'), 'utf8')).toBe('uncommitted\n')
    expect(await git(repo, 'worktree', 'list')).toContain(theirs)
  })

  it('leaves a file at the override\'s path that is not Domo\'s override', async () => {
    await mkdir(join(root, '.domo-worktrees'), { recursive: true })
    const file = join(root, '.domo-worktrees', 'env_1.container-gitdir')
    await writeFile(file, 'something else\n')

    await removeHostWorktree({ repoPath: repo, environmentId: 'env_1' })
    expect(await readFile(file, 'utf8')).toBe('something else\n')
  })

  it('is a no-op for an environment that never had a worktree', async () => {
    expect(await removeHostWorktree({ repoPath: repo, environmentId: 'env_never' })).toEqual([])
    expect(await git(repo, 'worktree', 'list')).toBe(`${repo}  ${await git(repo, 'rev-parse', '--short', 'HEAD')} [main]`)
  })
})
