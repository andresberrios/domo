import { beforeEach, describe, expect, it } from 'vitest'

import { query } from '../../server/lib/db'
import { cronJobState, normalizeCronJobInput } from '../../server/lib/cron/input'
import {
  claimCronJob,
  createAgentSession,
  createCronJob,
  deleteAgentSession,
  finishCronRun,
  getCronJob,
  listCronJobs,
  replaceCronJob,
  listCronRuns,
  listDueCronJobs
} from '../../server/lib/repo'

beforeEach(async () => {
  await query('truncate agent_sessions cascade')
})

async function agent() {
  return createAgentSession({ adapter: 'claude-code', title: 'scheduled', cwd: '/tmp' })
}

describe('durable scheduled prompts', () => {
  it('stores both recurring and one-time schedules for an agent', async () => {
    const target = await agent()
    const recurring = await createCronJob(normalizeCronJobInput({
      agentSessionId: target.id,
      name: 'Weekday check',
      prompt: 'Inspect CI',
      cronExpression: '0 9 * * 1-5',
      timezone: 'Europe/Amsterdam'
    }, new Date('2026-09-21T00:00:00Z')))
    const once = await createCronJob(normalizeCronJobInput({
      agentSessionId: target.id,
      name: 'Wake once',
      prompt: 'Finish the report',
      runAt: '2026-09-22T12:00:00Z'
    }, new Date('2026-09-21T00:00:00Z')))

    expect(recurring).toMatchObject({ scheduleType: 'cron', timezone: 'Europe/Amsterdam' })
    expect(once).toMatchObject({ scheduleType: 'once', nextRunAt: '2026-09-22T12:00:00.000Z' })
    await expect(listCronJobs(target.id)).resolves.toHaveLength(2)
  })

  it('claims a due occurrence exactly once across concurrent scheduler ticks', async () => {
    const target = await agent()
    const job = await createCronJob(normalizeCronJobInput({
      agentSessionId: target.id,
      name: 'Claim me',
      prompt: 'Run once',
      runAt: '2099-01-01T00:00:00Z'
    }))
    const due = '2026-09-21T10:00:00.000Z'
    await query('update cron_jobs set next_run_at = $2 where id = $1', [job.id, due])
    await expect(listDueCronJobs('2026-09-21T10:00:01.000Z')).resolves.toHaveLength(1)

    const claims = await Promise.all([
      claimCronJob(job.id, due, null),
      claimCronJob(job.id, due, null)
    ])
    const run = claims.find(Boolean)!
    expect(claims.filter(Boolean)).toHaveLength(1)
    // A one-time task that fired is done: put away, its history still there.
    expect(await getCronJob(job.id)).toMatchObject({ enabled: false, archived: true, runCount: 1, lastStatus: 'running' })
    await expect(listCronJobs(target.id)).resolves.toEqual([])
    await expect(listCronJobs(target.id, { includeArchived: true })).resolves.toHaveLength(1)

    await finishCronRun(run.id, 'delivered', 'queued')
    expect(await getCronJob(job.id)).toMatchObject({ lastStatus: 'delivered', lastError: null })
    await expect(listCronRuns(job.id)).resolves.toMatchObject([
      { scheduledFor: due, status: 'delivered', outcome: 'queued' }
    ])
  })

  it('keeps a recurring task listed when it fires', async () => {
    const target = await agent()
    const job = await createCronJob(normalizeCronJobInput({
      agentSessionId: target.id, name: 'Daily', prompt: 'Run', cronExpression: '0 9 * * *'
    }))
    await claimCronJob(job.id, job.nextRunAt!, '2099-01-01T09:00:00.000Z')
    expect(await getCronJob(job.id)).toMatchObject({ enabled: true, archived: false, runCount: 1 })
  })

  it('never offers an archived task to the scheduler, even one somehow left due', async () => {
    const target = await agent()
    const job = await createCronJob(normalizeCronJobInput({
      agentSessionId: target.id, name: 'Put away', prompt: 'Run', cronExpression: '0 9 * * *'
    }))
    const due = '2026-09-21T10:00:00.000Z'
    await query('update cron_jobs set next_run_at = $2, archived = true where id = $1', [job.id, due])
    await expect(listDueCronJobs('2026-09-21T10:00:01.000Z')).resolves.toEqual([])
    await expect(claimCronJob(job.id, due, null)).resolves.toBeNull()
  })

  it('archives only a paused task, and resuming one unarchives it', async () => {
    const target = await agent()
    const base = { agentSessionId: target.id, name: 'Daily', prompt: 'Run', cronExpression: '0 9 * * *' }
    const job = await createCronJob(normalizeCronJobInput(base))

    const archived = await replaceCronJob(job.id, normalizeCronJobInput({ ...base, ...cronJobState(job, { archived: true }) }))
    expect(archived).toMatchObject({ enabled: false, archived: true, nextRunAt: null })

    const back = await replaceCronJob(job.id, normalizeCronJobInput({ ...base, ...cronJobState(archived!, { archived: false }) }))
    expect(back).toMatchObject({ enabled: false, archived: false })

    const rearchived = await replaceCronJob(job.id, normalizeCronJobInput({ ...base, ...cronJobState(back!, { archived: true }) }))
    const resumed = await replaceCronJob(job.id, normalizeCronJobInput({ ...base, ...cronJobState(rearchived!, { enabled: true }) }))
    expect(resumed).toMatchObject({ enabled: true, archived: false })
    expect(resumed!.nextRunAt).not.toBeNull()
  })

  it('removes schedules and run history with their target agent', async () => {
    const target = await agent()
    const job = await createCronJob(normalizeCronJobInput({
      agentSessionId: target.id, name: 'Temporary', prompt: 'Run', runAt: '2099-01-01T00:00:00Z'
    }))
    await deleteAgentSession(target.id)
    await expect(getCronJob(job.id)).resolves.toBeNull()
  })
})
