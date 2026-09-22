import { acpManager } from '../acp/manager'
import { isRetired } from '../acp/retirement'
import { nextCronOccurrence } from './expression'
import {
  appendAgentEvent,
  claimCronJob,
  disableCronJobsForAgent,
  failCronJobSchedule,
  finishCronRun,
  getAgentSession,
  listDueCronJobs
} from '../repo'
import type { CronJob } from '../../../shared/types'

const TICK_MS = 15_000

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // Drain bounded batches so a machine waking after a long sleep does not
      // make new due work wait for another timer interval.
      for (;;) {
        const jobs = await listDueCronJobs(now.toISOString())
        if (!jobs.length) break
        for (const job of jobs) await this.fire(job, now)
        if (jobs.length < 25) break
      }
    } catch (error) {
      console.error('[cron] scheduler tick failed', error)
    } finally {
      this.ticking = false
    }
  }

  private async fire(job: CronJob, now: Date): Promise<void> {
    if (!job.nextRunAt) return
    // Retiring a session disables its schedules, so this is the case where the
    // two raced — a job claimed in the same tick the session was retired in.
    // Disabling here as well means a due job can never spin: the alternative is
    // a failed run every fifteen seconds for ever.
    if (isRetired(await getAgentSession(job.agentSessionId))) {
      await disableCronJobsForAgent(job.agentSessionId)
      return
    }
    let nextRunAt: string | null
    try {
      // Catch-up is deliberately one firing, not replay: after downtime the
      // overdue job runs once and the pointer jumps past every missed instant.
      nextRunAt = job.scheduleType === 'cron'
        ? nextCronOccurrence(job.cronExpression!, job.timezone, now).toISOString()
        : null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await failCronJobSchedule(job.id, job.nextRunAt, message)
      return
    }
    const run = await claimCronJob(job.id, job.nextRunAt, nextRunAt)
    if (!run) return

    try {
      const result = await acpManager.deliver(job.agentSessionId, {
        content: [{
          type: 'text',
          text: `[Scheduled task "${job.name}" (${job.id})]\n\n${job.prompt}`
        }],
        delivery: job.delivery,
        origin: `cron:${job.id}`
      })
      await appendAgentEvent(job.agentSessionId, 'cron_triggered', {
        cronJobId: job.id,
        name: job.name,
        scheduledFor: run.scheduledFor,
        delivery: result.delivery,
        outcome: result.outcome
      })
      await finishCronRun(run.id, 'delivered', result.outcome)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishCronRun(run.id, 'failed', message).catch(() => {})
      console.error(`[cron:${job.id}] delivery failed`, error)
    }
  }
}

const globalKey = '__domo_cron_scheduler__'
const g = globalThis as any
export const cronScheduler: CronScheduler = g[globalKey] ?? (g[globalKey] = new CronScheduler())
