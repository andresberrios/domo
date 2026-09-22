import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CronJob } from '../../shared/types'
import { CronScheduler } from '../../server/lib/cron/scheduler'

const acp = vi.hoisted(() => ({
  deliver: vi.fn(async () => ({ delivery: 'queue', outcome: 'queued' }))
}))
const repo = vi.hoisted(() => ({
  listDueCronJobs: vi.fn(),
  claimCronJob: vi.fn(),
  finishCronRun: vi.fn(async () => {}),
  failCronJobSchedule: vi.fn(async () => true),
  appendAgentEvent: vi.fn(async () => {}),
  // A job due against a session that cannot start is dropped rather than fired,
  // so every firing begins by reading the session and the environment it names.
  // The default here is a host session, which is always startable.
  getAgentSessionWithEnvironment: vi.fn(async () => ({
    session: { id: 'ag_1', title: 'Agent', cwd: '/srv/api', devEnvironmentId: null },
    environment: null
  })),
  disableCronJobsForAgent: vi.fn(async () => 0)
}))

vi.mock('../../server/lib/acp/manager', () => ({ acpManager: acp }))
vi.mock('../../server/lib/repo', () => repo)

function job(patch: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron_1',
    agentSessionId: 'ag_1',
    name: 'Check CI',
    prompt: 'Inspect CI and fix regressions.',
    scheduleType: 'cron',
    cronExpression: '* * * * *',
    timezone: 'UTC',
    runAt: null,
    enabled: true,
    delivery: 'queue',
    nextRunAt: '2026-09-21T10:00:00.000Z',
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    createdBy: 'user',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...patch
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  repo.listDueCronJobs.mockResolvedValue([job()])
  repo.claimCronJob.mockResolvedValue({
    id: 'crun_1', cronJobId: 'cron_1', scheduledFor: job().nextRunAt,
    startedAt: '2026-09-21T10:00:02.000Z', finishedAt: null,
    status: 'running', outcome: null, error: null
  })
})

describe('cron scheduler', () => {
  it('claims the due instant, advances it, and wakes the agent through normal delivery', async () => {
    await new CronScheduler().tick(new Date('2026-09-21T10:00:02.000Z'))

    expect(repo.claimCronJob).toHaveBeenCalledWith(
      'cron_1',
      '2026-09-21T10:00:00.000Z',
      '2026-09-21T10:01:00.000Z'
    )
    expect(acp.deliver).toHaveBeenCalledWith('ag_1', {
      content: [{ type: 'text', text: '[Scheduled task "Check CI" (cron_1)]\n\nInspect CI and fix regressions.' }],
      delivery: 'queue',
      origin: 'cron:cron_1'
    })
    expect(repo.finishCronRun).toHaveBeenCalledWith('crun_1', 'delivered', 'queued')
  })

  it('records a delivery failure without losing the scheduler loop', async () => {
    acp.deliver.mockRejectedValueOnce(new Error('adapter unavailable'))

    await new CronScheduler().tick(new Date('2026-09-21T10:00:02.000Z'))

    expect(repo.finishCronRun).toHaveBeenCalledWith('crun_1', 'failed', 'adapter unavailable')
  })

  it('does nothing when another scheduler claimed the same occurrence', async () => {
    repo.claimCronJob.mockResolvedValueOnce(null)

    await new CronScheduler().tick(new Date('2026-09-21T10:00:02.000Z'))

    expect(acp.deliver).not.toHaveBeenCalled()
  })

  it('disables an impossible schedule and continues with later jobs', async () => {
    const impossible = job({ id: 'cron_bad', cronExpression: '0 0 30 2 *' })
    const later = job({ id: 'cron_good', agentSessionId: 'ag_2' })
    repo.listDueCronJobs.mockResolvedValueOnce([impossible, later])
    repo.claimCronJob.mockImplementation(async (id: string) => ({
      id: `crun_${id}`,
      cronJobId: id,
      scheduledFor: job().nextRunAt,
      startedAt: '2026-09-21T10:00:02.000Z',
      finishedAt: null,
      status: 'running',
      outcome: null,
      error: null
    }))

    await new CronScheduler().tick(new Date('2026-09-21T10:00:02.000Z'))

    expect(repo.failCronJobSchedule).toHaveBeenCalledWith(
      'cron_bad',
      '2026-09-21T10:00:00.000Z',
      expect.stringContaining('no occurrence')
    )
    expect(acp.deliver).toHaveBeenCalledWith('ag_2', expect.anything())
  })
})
