import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which branch, told how, and who is never woken.
 *
 * The git is mocked here on purpose: the commit-then-merge sequence against
 * real repositories is `test/server/branch-import.spec.ts`, and what is left
 * over — the decisions — is what this pins. They are the parts that have no
 * visible failure mode, so they are the parts worth stating twice.
 */

const acp = vi.hoisted(() => ({
  isBusy: vi.fn((_agentSessionId: string) => false),
  supportsSteering: vi.fn((_agentSessionId: string) => true),
  deliver: vi.fn(async (_agentSessionId: string, _input: any) => ({ delivered: true }))
}))
const gitSync = vi.hoisted(() => ({
  importBranch: vi.fn(async (input: any) => ({
    branch: input.branch,
    from: input.from,
    sha: 'c0ffee'.padEnd(40, '0'),
    commits: [{ sha: 'c0ffee'.padEnd(40, '0'), subject: 'landed on the host' }],
    result: 'fast-forwarded'
  }))
}))
const repo = vi.hoisted(() => ({
  getDevEnvironment: vi.fn(async () => ({ id: 'env_1', name: 'env', remoteUser: 'vscode' } as any)),
  listAgentSessions: vi.fn(async () => [] as any[]),
  enqueueInboxMessage: vi.fn(async (_input: any) => ({} as any))
}))

/**
 * Git inside the environment. `HEAD` moves once per merge so the "already had
 * it" case is distinguishable from a real one, and the merge itself is whatever
 * the test says it is.
 */
const container = vi.hoisted(() => ({ head: 'aaa', branch: 'main', dirty: '', mergeFails: false }))
const environmentGit = vi.hoisted(() => vi.fn(async (_environment: any, args: string[]) => {
  const answer = (stdout: string) => ({ stdout, stderr: '' })
  if (args[0] === 'symbolic-ref') return answer(container.branch)
  if (args[0] === 'status') return answer(container.dirty)
  if (args[0] === 'rev-parse') return answer(container.head)
  if (args[0] === 'config') return answer('dev@example.com')
  if (args[0] === 'add') return answer('')
  if (args.includes('commit')) {
    container.dirty = ''
    container.head = 'wip'.padEnd(40, '0')
    return answer('')
  }
  if (args[0] === 'merge' && args[1] === '--abort') return answer('')
  if (args[0] === 'merge') {
    if (container.mergeFails) throw new Error('git merge failed: CONFLICT')
    container.head = 'merged'.padEnd(40, '0')
    return answer('')
  }
  return answer('')
}))

vi.mock('../../server/lib/acp/manager', () => ({ acpManager: acp }))
vi.mock('../../server/lib/dev-env/git-sync', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/lib/dev-env/git-sync')>(),
  ...gitSync
}))
vi.mock('../../server/lib/repo', () => repo)

const { importBranchIntoEnvironment, sideBranch } = await import('../../server/lib/branch-import')

function session(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: `agent ${id}`, devEnvironmentId: 'env_1', status: 'idle', ...overrides }
}

const importIt = (branch = 'main', from?: string) =>
  importBranchIntoEnvironment({ environmentId: 'env_1', branch, from, environmentGit, transport: () => 'ext::x' })

/** The text of the one notice a session was given, whichever path it took. */
function noticeTo(agentSessionId: string): string {
  const delivered = acp.deliver.mock.calls.find(call => call[0] === agentSessionId)
  const queued = repo.enqueueInboxMessage.mock.calls.find(call => call[0].agentSessionId === agentSessionId)
  const content = delivered?.[1]?.content ?? queued?.[0]?.content
  return content?.[0]?.text ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  acp.isBusy.mockReturnValue(false)
  acp.supportsSteering.mockReturnValue(true)
  // `clearAllMocks` clears calls, not implementations, so a `mockResolvedValue`
  // in one test would otherwise be the default for every test after it.
  gitSync.importBranch.mockImplementation(async (input: any) => ({
    branch: input.branch,
    from: input.from,
    sha: 'c0ffee'.padEnd(40, '0'),
    commits: [{ sha: 'c0ffee'.padEnd(40, '0'), subject: 'landed on the host' }],
    result: 'fast-forwarded'
  }))
  repo.getDevEnvironment.mockResolvedValue({ id: 'env_1', name: 'env', remoteUser: 'vscode' } as any)
  repo.listAgentSessions.mockResolvedValue([session('ag_1')])
  repo.enqueueInboxMessage.mockResolvedValue({})
  Object.assign(container, { head: 'aaa', branch: 'main', dirty: '', mergeFails: false })
})

describe('importing into an environment', () => {
  // The imported commits always land on a ref of their own before a merge: a
  // branch with a working tree attached is not something a push can move.
  it('sends to a side branch and merges into the one the environment is on', async () => {
    const result = await importIt('main')

    expect(gitSync.importBranch).toHaveBeenCalledWith(expect.objectContaining({
      branch: sideBranch('main'),
      // Resolved against what was asked for: there is no `domo-import/main` on
      // the host to send.
      from: 'main'
    }))
    expect(environmentGit).toHaveBeenCalledWith(expect.anything(), ['merge', '--no-edit', 'domo-import/main'])
    expect(result).toMatchObject({ requested: 'main', result: 'merged' })
  })

  it('pushes straight to a branch nobody has checked out, and merges nothing', async () => {
    const result = await importIt('release')

    expect(gitSync.importBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'release' }))
    expect(environmentGit).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['merge']))
    expect(result).toMatchObject({ branch: 'release', result: 'fast-forwarded', wip: null })
  })

  it('commits what is uncommitted before it merges, and never after', async () => {
    container.dirty = ' M app/main.css\n'

    const result = await importIt('main')

    const order = environmentGit.mock.calls.map(call => call[1].join(' '))
    expect(order.findIndex(entry => entry.includes('commit')))
      .toBeLessThan(order.findIndex(entry => entry.startsWith('merge')))
    expect(order).toContain('add --all')
    expect(result.wip).toBeTruthy()
  })

  it('leaves a clean checkout alone rather than making an empty commit', async () => {
    const result = await importIt('main')

    expect(environmentGit).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['add']))
    expect(result.wip).toBeNull()
  })

  /**
   * A half-merged working tree under a running agent is read as its own work,
   * so a conflict has to leave nothing behind but the side branch.
   */
  it('aborts a conflicting merge and points at the side branch', async () => {
    container.mergeFails = true

    const result = await importIt('main')

    expect(environmentGit).toHaveBeenCalledWith(expect.anything(), ['merge', '--abort'], expect.anything())
    expect(result.result).toBe('not-merged')
    expect(result.reason).toContain('domo-import/main')
    expect(result.reason).toMatch(/aborted/)
  })

  it('leaves the branch on the side ref while an agent is mid-turn, touching nothing', async () => {
    acp.isBusy.mockReturnValue(true)
    container.dirty = ' M app/main.css\n'

    const result = await importIt('main')

    expect(environmentGit).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['add']))
    expect(environmentGit).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['merge']))
    expect(result).toMatchObject({ branch: 'domo-import/main', wip: null })
    expect(result.diverted).toMatch(/mid-turn/)
  })
})

describe('telling the agents where the changes are', () => {
  it('steers a working agent whose adapter advertises steering', async () => {
    acp.isBusy.mockReturnValue(true)

    const result = await importIt('main')

    expect(acp.deliver).toHaveBeenCalledWith('ag_1', expect.objectContaining({
      delivery: 'steer',
      origin: 'system'
    }))
    expect(result.notified).toEqual([{ agentSessionId: 'ag_1', title: 'agent ag_1', via: 'steer' }])
    expect(noticeTo('ag_1')).toMatch(/git merge domo-import\/main/)
  })

  /**
   * The measured reason this is not hard-coded to `steer`: an `initialize` to
   * opencode comes back with no `_meta` at all, and `steer` on an adapter
   * without it falls back to **`interrupt`** — cancelling a running turn to
   * hand over a branch, which is far blunter than the news deserves.
   */
  it('queues rather than interrupts an adapter that cannot be steered', async () => {
    acp.isBusy.mockReturnValue(true)
    acp.supportsSteering.mockReturnValue(false)

    const result = await importIt('main')

    expect(acp.deliver).toHaveBeenCalledWith('ag_1', expect.objectContaining({ delivery: 'queue' }))
    expect(acp.deliver).not.toHaveBeenCalledWith('ag_1', expect.objectContaining({ delivery: 'interrupt' }))
    expect(result.notified[0]!.via).toBe('queue')
  })

  /**
   * `deliver()` starts the adapter it delivers to, so a note about a branch
   * would spawn a process for every stopped session in the environment. The
   * row is written straight to the inbox instead — the same thing
   * `subscriptions.ts` does, for the same reason.
   */
  it('writes an idle agent a row and does not wake it', async () => {
    const result = await importIt('main')

    expect(acp.deliver).not.toHaveBeenCalled()
    expect(repo.enqueueInboxMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: 'ag_1',
      delivery: 'queue',
      origin: 'system'
    }))
    expect(result.notified[0]!.via).toBe('inbox')
  })

  it('tells an idle agent the merge happened, not to go merge something', async () => {
    await importIt('main')

    expect(noticeTo('ag_1')).toMatch(/merged it into "main"/)
    expect(noticeTo('ag_1')).not.toMatch(/git merge/)
  })

  // The agent has to know its files were committed, and that nothing was thrown
  // away — otherwise a commit it did not make looks like something went wrong.
  it('names the commit an agent\'s uncommitted work was parked in', async () => {
    container.dirty = ' M app/main.css\n'

    await importIt('main')

    expect(noticeTo('ag_1')).toMatch(/uncommitted files were committed first/)
    expect(noticeTo('ag_1')).toMatch(/nothing was stashed or discarded/)
  })

  it('tells every session in the environment, and no session outside it', async () => {
    repo.listAgentSessions.mockResolvedValue([
      session('ag_1'),
      session('ag_2'),
      session('ag_elsewhere', { devEnvironmentId: 'env_other' })
    ])

    const result = await importIt('main')

    expect(result.notified.map(entry => entry.agentSessionId)).toEqual(['ag_1', 'ag_2'])
  })

  // Nothing landed, so there is nothing to tell anybody; the caller has the
  // reason and is the one who can act on it.
  it('tells nobody when nothing was sent', async () => {
    gitSync.importBranch.mockResolvedValue({
      branch: 'main',
      from: 'main',
      sha: 'a'.repeat(40),
      commits: [],
      result: 'not-merged',
      reason: 'its working tree has local changes'
    } as any)

    const result = await importIt('main')

    expect(result.notified).toEqual([])
    expect(acp.deliver).not.toHaveBeenCalled()
    expect(repo.enqueueInboxMessage).not.toHaveBeenCalled()
    expect(result.reason).toMatch(/local changes/)
  })

  // One agent that cannot be reached must not cost the others their message,
  // nor turn a completed import into a failure.
  it('keeps going when one session cannot be told', async () => {
    repo.listAgentSessions.mockResolvedValue([session('ag_1'), session('ag_2')])
    repo.enqueueInboxMessage.mockRejectedValueOnce(new Error('gone'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await importIt('main')

    expect(result.result).toBe('merged')
    expect(result.notified.map(entry => entry.agentSessionId)).toEqual(['ag_2'])
  })
})
