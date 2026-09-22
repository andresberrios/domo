import { beforeEach, describe, expect, it } from 'vitest'

import { query } from '../../server/lib/db'
import { normalizeCronJobInput } from '../../server/lib/cron/input'
import {
  claimCronJob,
  createAgentSession,
  createCronJob,
  deleteAgentSession,
  finishCronRun,
  getCronJob,
  listCronJobs,
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
    expect(await getCronJob(job.id)).toMatchObject({ enabled: false, runCount: 1, lastStatus: 'running' })

    await finishCronRun(run.id, 'delivered', 'queued')
    expect(await getCronJob(job.id)).toMatchObject({ lastStatus: 'delivered', lastError: null })
    await expect(listCronRuns(job.id)).resolves.toMatchObject([
      { scheduledFor: due, status: 'delivered', outcome: 'queued' }
    ])
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
