import type { CronJob, CronRunNowResult } from '~~/shared/types'

/**
 * Run a scheduled task now. Its next occurrence stays put, and its "if busy"
 * setting decides what happens to a turn that is running; the toast says which.
 */
export function useRunCronJob() {
  const toast = useToast()
  const running = ref<string | null>(null)

  async function runNow(job: CronJob): Promise<CronRunNowResult | null> {
    running.value = job.id
    try {
      const result = await $fetch<CronRunNowResult>(`/api/cron-jobs/${job.id}/run`, { method: 'POST' })
      toast.add({ title: `Ran “${job.name}”`, description: runNowOutcome(result), color: 'success', icon: 'i-lucide-play' })
      return result
    } catch (error: any) {
      toast.add({ title: `Could not run “${job.name}”`, description: error?.data?.statusMessage ?? error?.message, color: 'error' })
      return null
    } finally {
      running.value = null
    }
  }

  return { running, runNow }
}
