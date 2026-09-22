import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DevEnvironment } from '../../shared/types'

/**
 * The commit-then-merge sequence, against real git on both ends and no Docker.
 *
 * This is the half that cannot be checked with mocks: whether a WIP commit
 * really captures an agent's files, whether the merge that follows produces the
 * history it should, and — the one that matters most — whether a conflicting
 * import leaves the environment's working tree exactly as it found it. A
 * half-merged tree under a running agent is worse than no import at all.
 *
 * `acpManager` is faked, because what it contributes here is one boolean (is a
 * turn in flight) and the delivery of a notice; `branch-import.spec.ts` in
 * `test/unit` covers those decisions. Everything git is real.
 */

const acp = vi.hoisted(() => ({
  isBusy: vi.fn((_id: string) => false),
  supportsSteering: vi.fn((_id: string) => true),
  deliver: vi.fn(async (_id: string, _input: any) => ({ delivered: true }))
}))
vi.mock('../../server/lib/acp/manager', () => ({ acpManager: acp }))

const { run } = await import('../../server/lib/dev-env/docker')
const { importBranchIntoEnvironment, previewImport } = await import('../../server/lib/branch-import')
const { createAgentSession, createDevEnvironmentRow, createProject, listInboxMessages }
  = await import('../../server/lib/repo')

const scratch: string[] = []
let counter = 0
let host: string
let container: string
let environment: DevEnvironment

const transport = () => `ext::%S ${container}`
/** Git inside the "environment", which here is just a second checkout on disk. */
const environmentGit = async (_environment: DevEnvironment, args: string[], options: any = {}) =>
  run('git', [
    '-C', container,
    '-c', 'user.name=Env User',
    '-c', 'user.email=env@example.com',
    '-c', 'commit.gpgsign=false',
    ...args
  ], options)

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
  const path = await mkdtemp(join(tmpdir(), `domo-branch-import-${prefix}-`))
  scratch.push(path)
  return path
}

async function commit(repo: string, name: string, message: string) {
  await writeFile(join(repo, name), `${message}\n`, 'utf8')
  await git(repo, 'add', name)
  await git(repo, 'commit', '--quiet', '-m', message)
  return (await git(repo, 'rev-parse', 'HEAD')).stdout
}

const inContainer = async (...args: string[]) => (await git(container, ...args)).stdout

const importIt = (branch = 'main', from?: string) =>
  importBranchIntoEnvironment({ environmentId: environment.id, branch, from, transport, environmentGit })

const previewIt = (branch = 'main', from?: string) =>
  previewImport({ environmentId: environment.id, branch, from, transport, environmentGit })

beforeEach(async () => {
  vi.clearAllMocks()
  acp.isBusy.mockReturnValue(false)

  host = await temp('host')
  await run('git', ['init', '--quiet', '--initial-branch=main', host])
  await commit(host, 'README.md', 'first')

  // What an environment's volume holds: a copy of the project's checkout, on
  // the same branch the host is on. That is the case an import exists for.
  container = await temp('container')
  await run('git', ['clone', '--quiet', host, container])

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

describe('importing into the branch the environment is on', () => {
  it('fast-forwards a clean checkout and leaves no merge commit behind', async () => {
    const sha = await commit(host, 'landed.txt', 'landed on the host')

    const result = await importIt('main')

    expect(result).toMatchObject({ requested: 'main', result: 'merged', wip: null })
    await expect(inContainer('rev-parse', 'HEAD')).resolves.toBe(sha)
    await expect(readFile(join(container, 'landed.txt'), 'utf8')).resolves.toBe('landed on the host\n')
    await expect(inContainer('status', '--porcelain')).resolves.toBe('')
  })

  /**
   * The case the refusal used to block, and the reason the order is what it is:
   * an agent in the middle of something *has* uncommitted files, and that is
   * exactly when an import is most wanted.
   */
  it('commits what the agent left uncommitted, then merges', async () => {
    await writeFile(join(container, 'agent.txt'), 'half-finished work\n', 'utf8')
    await writeFile(join(container, 'README.md'), 'edited by the agent\n', 'utf8')
    const sha = await commit(host, 'landed.txt', 'landed on the host')

    const result = await importIt('main')

    expect(result.result).toBe('merged')
    expect(result.wip).toMatch(/^[0-9a-f]{40}$/)

    // Nothing stashed, nothing discarded: the agent's files are in the history
    // *and* still on disk, and the host's commit arrived beside them.
    await expect(readFile(join(container, 'agent.txt'), 'utf8')).resolves.toBe('half-finished work\n')
    await expect(readFile(join(container, 'README.md'), 'utf8')).resolves.toBe('edited by the agent\n')
    await expect(readFile(join(container, 'landed.txt'), 'utf8')).resolves.toBe('landed on the host\n')
    await expect(inContainer('status', '--porcelain')).resolves.toBe('')

    // The WIP commit is a real, findable commit, and the merge brought the host in.
    await expect(inContainer('show', `${result.wip}:agent.txt`)).resolves.toBe('half-finished work')
    await expect(inContainer('log', '--format=%s', '-1', result.wip!))
      .resolves.toMatch(/Domo committed work in progress on main/)
    await expect(inContainer('merge-base', '--is-ancestor', sha, 'HEAD')).resolves.toBe('')
  })

  it('says up-to-date when the environment already had everything', async () => {
    await commit(host, 'landed.txt', 'landed on the host')
    await importIt('main')

    const result = await importIt('main')

    expect(result.result).toBe('up-to-date')
  })

  /**
   * The one that has to be exactly right. A conflicted working tree handed to a
   * running agent is read as its own work, so the merge is aborted and the tree
   * is left as it was — with the imported commits still on the side branch, and
   * the agent's own work safely committed rather than stranded.
   */
  it('aborts a conflicting merge and leaves the working tree untouched', async () => {
    await writeFile(join(container, 'README.md'), 'the agent rewrote this\n', 'utf8')
    await commit(host, 'README.md', 'and so did the host')

    const result = await importIt('main')

    expect(result.result).toBe('not-merged')
    expect(result.reason).toMatch(/conflicts/)
    expect(result.branch).toBe('domo-import/main')
    expect(result.wip).toMatch(/^[0-9a-f]{40}$/)

    // No conflict markers, no MERGE_HEAD, nothing half-done.
    await expect(readFile(join(container, 'README.md'), 'utf8')).resolves.toBe('the agent rewrote this\n')
    await expect(inContainer('status', '--porcelain')).resolves.toBe('')
    await expect(run('git', ['-C', container, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
      allowFailure: true
    })).resolves.toMatchObject({ stdout: '' })

    // The work is not lost — it is on the side branch, and the reason names it.
    await expect(inContainer('rev-parse', 'refs/heads/domo-import/main')).resolves.toMatch(/^[0-9a-f]{40}$/)
    expect(result.reason).toContain('domo-import/main')
  })

  // A turn in flight is holding files open and about to write more: committing
  // and merging under it is its own way of losing work.
  it('leaves the branch on the side ref while an agent is mid-turn', async () => {
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'the worker',
      cwd: environment.workspacePath,
      devEnvironmentId: environment.id
    })
    acp.isBusy.mockImplementation((id: string) => id === agent.id)
    await writeFile(join(container, 'agent.txt'), 'being written right now\n', 'utf8')
    const sha = await commit(host, 'landed.txt', 'landed on the host')

    const result = await importIt('main')

    expect(result.branch).toBe('domo-import/main')
    expect(result.diverted).toMatch(/mid-turn/)
    // Nothing was committed and nothing was merged.
    expect(result.wip).toBeNull()
    await expect(inContainer('status', '--porcelain')).resolves.toContain('agent.txt')
    await expect(inContainer('rev-parse', 'refs/heads/domo-import/main')).resolves.toBe(sha)
    await expect(inContainer('rev-parse', 'HEAD')).resolves.not.toBe(sha)
    // And it was told, in the running turn, where to find them.
    expect(acp.deliver).toHaveBeenCalledWith(agent.id, expect.objectContaining({ delivery: 'steer' }))
    expect(result.notified).toEqual([{ agentSessionId: agent.id, title: 'the worker', via: 'steer' }])
  })

  // The whole point of the sequence: an idle agent that comes back finds both
  // the merge and a row in its inbox explaining what happened to its files.
  it('leaves an idle agent a note naming the commit its work was parked in', async () => {
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'the worker',
      cwd: environment.workspacePath,
      devEnvironmentId: environment.id
    })
    await writeFile(join(container, 'agent.txt'), 'half-finished work\n', 'utf8')
    await commit(host, 'landed.txt', 'landed on the host')

    const result = await importIt('main')

    expect(acp.deliver).not.toHaveBeenCalled()
    const waiting = await listInboxMessages(agent.id)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.origin).toBe('system')
    const text = (waiting[0]!.content as any[])[0].text as string
    expect(text).toContain('merged it into "main"')
    expect(text).toContain(result.wip!.slice(0, 8))
    expect(text).toMatch(/nothing was stashed or discarded/)
  })
})

describe('importing into any other branch', () => {
  it('pushes straight to it without touching the working tree', async () => {
    await writeFile(join(container, 'agent.txt'), 'untouched\n', 'utf8')
    await git(host, 'checkout', '--quiet', '-b', 'release')
    const sha = await commit(host, 'release.txt', 'cut the release')

    const result = await importIt('release')

    expect(result).toMatchObject({ branch: 'release', result: 'created', wip: null })
    await expect(inContainer('rev-parse', 'refs/heads/release')).resolves.toBe(sha)
    await expect(readFile(join(container, 'agent.txt'), 'utf8')).resolves.toBe('untouched\n')
  })
})

/**
 * That the preview and the act agree is structural — both call the one pure
 * `planImport()` — but "structural" is a claim, and this is the test that makes
 * it an observation. A modal that can promise something the server will not do
 * is worse than no preview at all, so the two are run against the *same*
 * environment and compared.
 */
describe('the plan and the act agree', () => {
  it('on a clean merge into the checked-out branch', async () => {
    await commit(host, 'landed.txt', 'landed on the host')

    const plan = await previewIt('main')
    const done = await importIt('main')

    expect(plan).toMatchObject({ requested: 'main', from: 'main', branch: 'domo-import/main', merge: true })
    expect(plan.commitFirst).toBeNull()
    expect(done).toMatchObject({ requested: plan.requested, branch: plan.branch, from: plan.from })
    // The plan said it would not have to commit anything, and it did not.
    expect(done.wip).toBeNull()
    // Nothing was left over, so nobody was asked — the plan only ever named who
    // *would* be asked if anything were.
    expect(done.resolver).toBeNull()
  })

  it('on a dirty checkout, down to the number of files it said it would commit', async () => {
    await writeFile(join(container, 'one.txt'), 'a\n', 'utf8')
    await writeFile(join(container, 'two.txt'), 'b\n', 'utf8')
    await commit(host, 'landed.txt', 'landed on the host')

    const plan = await previewIt('main')
    const done = await importIt('main')

    expect(plan.commitFirst).toMatchObject({ total: 2 })
    expect(plan.commitFirst!.paths.sort()).toEqual(['one.txt', 'two.txt'])
    expect(done.wip).toMatch(/^[0-9a-f]{40}$/)
    // And exactly those files are in the commit the plan promised.
    const committed = await inContainer('show', '--name-only', '--format=', done.wip!)
    expect(committed.split('\n').filter(Boolean).sort()).toEqual(['one.txt', 'two.txt'])
  })

  it('on a branch left aside because an agent is mid-turn, including who is asked', async () => {
    const agent = await createAgentSession({
      adapter: 'claude-code',
      title: 'the worker',
      cwd: environment.workspacePath,
      devEnvironmentId: environment.id
    })
    acp.isBusy.mockImplementation((id: string) => id === agent.id)
    await commit(host, 'landed.txt', 'landed on the host')

    const plan = await previewIt('main')
    const done = await importIt('main')

    expect(plan).toMatchObject({
      branch: 'domo-import/main',
      toSideBranch: true,
      sideBranchReason: 'agent-mid-turn',
      merge: false
    })
    expect(plan.resolver).toMatchObject({ agentSessionId: agent.id, title: 'the worker' })
    expect(plan.notify.map(entry => entry.agentSessionId)).toEqual([agent.id])

    expect(done.branch).toBe(plan.branch)
    expect(done.resolver).toMatchObject({ agentSessionId: agent.id })
    expect(done.notified.map(entry => entry.agentSessionId)).toEqual(plan.notify.map(entry => entry.agentSessionId))
  })
})
