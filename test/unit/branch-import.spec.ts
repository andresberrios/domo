import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What an import does *around* the git, which is the half that makes it worth
 * anything: an import into a branch the agent is not on is inert, because
 * nothing in a container tells an agent that some other branch moved.
 *
 * The git itself is `test/server/git-sync.spec.ts`, against real repositories;
 * everything below it is mocked here, because what is under test is a set of
 * decisions — which branch, told how, and who is never woken.
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
  })),
  listEnvironmentBranches: vi.fn(async () => ({ current: 'main', branches: [] }))
}))
const repo = vi.hoisted(() => ({
  listAgentSessions: vi.fn(async () => [] as any[]),
  enqueueInboxMessage: vi.fn(async (_input: any) => ({} as any))
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
  importBranchIntoEnvironment({ environmentId: 'env_1', branch, from })

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
  gitSync.listEnvironmentBranches.mockResolvedValue({ current: 'main', branches: [] })
  repo.listAgentSessions.mockResolvedValue([session('ag_1')])
  repo.enqueueInboxMessage.mockResolvedValue({})
})

describe('importing into an environment', () => {
  // The normal case, and the one the old refusal made impossible.
  it('writes the branch the idle agent has checked out', async () => {
    const result = await importIt('main')

    expect(gitSync.importBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'main', from: 'main' }))
    expect(result).toMatchObject({ requested: 'main', branch: 'main', result: 'fast-forwarded' })
    expect(result.diverted).toBeUndefined()
  })

  it('diverts to a side branch when any agent in the environment is mid-turn', async () => {
    acp.isBusy.mockReturnValue(true)

    const result = await importIt('main')

    expect(gitSync.importBranch).toHaveBeenCalledWith(expect.objectContaining({
      branch: sideBranch('main'),
      // Resolved against what was asked for: there is no `domo-import/main` on
      // the host to send.
      from: 'main'
    }))
    expect(result).toMatchObject({ requested: 'main', branch: 'domo-import/main' })
    expect(result.diverted).toMatch(/mid-turn/)
  })

  it('does not divert when the target is not the branch being worked on', async () => {
    acp.isBusy.mockReturnValue(true)

    const result = await importIt('release')

    expect(gitSync.importBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'release' }))
    expect(result.diverted).toBeUndefined()
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

  it('tells an idle agent its own working tree moved, not to go merge something', async () => {
    await importIt('main')

    expect(noticeTo('ag_1')).toMatch(/fast-forwarded your checked-out branch "main"/)
    expect(noticeTo('ag_1')).not.toMatch(/git merge/)
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

    expect(result.result).toBe('fast-forwarded')
    expect(result.notified.map(entry => entry.agentSessionId)).toEqual(['ag_2'])
  })
})
