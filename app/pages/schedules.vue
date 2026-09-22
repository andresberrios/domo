<script setup lang="ts">
import type { CronJob } from '~~/shared/types'

const toast = useToast()
const { sessions: agents } = useAgentSessions()
const { jobs } = useCronJobs()
const saving = ref(false)
const deleteOpen = ref(false)
const deletingJob = ref<CronJob | null>(null)
const scheduleType = ref<'cron' | 'once'>('cron')
const scheduleItems = [
  { label: 'Recurring', value: 'cron' },
  { label: 'One time', value: 'once' }
]
const deliveryItems = [
  { label: 'Queue', value: 'queue' },
  { label: 'Steer', value: 'steer' },
  { label: 'Interrupt', value: 'interrupt' }
]
const form = reactive({
  agentSessionId: '',
  name: '',
  prompt: '',
  cronExpression: '0 9 * * 1-5',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  runAt: '',
  delivery: 'queue'
})

watchEffect(() => {
  if (!form.agentSessionId && agents.value[0]) form.agentSessionId = agents.value[0].id
})

const agentItems = computed(() => agents.value.map(agent => ({ label: agent.title, value: agent.id })))

function agentName(id: string) {
  return agents.value.find(agent => agent.id === id)?.title ?? id
}

function when(job: CronJob) {
  if (job.scheduleType === 'once' && job.lastRunAt) {
    return `Ran ${new Date(job.lastRunAt).toLocaleString()}`
  }
  if (!job.enabled) return 'Paused'
  if (!job.nextRunAt) return 'No next run'
  return new Date(job.nextRunAt).toLocaleString()
}

async function createJob() {
  if (!form.agentSessionId || !form.name.trim() || !form.prompt.trim()) return
  saving.value = true
  try {
    await $fetch('/api/cron-jobs', {
      method: 'POST',
      body: {
        agentSessionId: form.agentSessionId,
        name: form.name,
        prompt: form.prompt,
        delivery: form.delivery,
        ...(scheduleType.value === 'cron'
          ? { cronExpression: form.cronExpression, timezone: form.timezone }
          : { runAt: new Date(form.runAt).toISOString() })
      }
    })
    form.name = ''
    form.prompt = ''
    toast.add({ title: 'Task scheduled', color: 'success' })
  } catch (error: any) {
    toast.add({ title: 'Could not schedule task', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  } finally {
    saving.value = false
  }
}

async function toggle(job: CronJob) {
  try {
    await $fetch(`/api/cron-jobs/${job.id}`, { method: 'PATCH', body: { enabled: !job.enabled } })
  } catch (error: any) {
    toast.add({ title: 'Could not update task', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
  }
}

function askToRemove(job: CronJob) {
  deletingJob.value = job
  deleteOpen.value = true
}

async function remove() {
  if (!deletingJob.value) return
  await $fetch(`/api/cron-jobs/${deletingJob.value.id}`, { method: 'DELETE' })
  deleteOpen.value = false
  deletingJob.value = null
}
</script>

<template>
  <UDashboardPanel id="schedules">
    <template #header>
      <UDashboardNavbar title="Schedules" icon="i-lucide-clock-3" />
    </template>

    <template #body>
      <div class="mx-auto w-full max-w-4xl space-y-6 py-4">
        <UAlert
          icon="i-lucide-alarm-clock"
          color="primary"
          variant="subtle"
          title="Wake an agent with a prompt"
          description="Schedules are stored in Postgres and survive server or agent restarts. If an agent is busy, queued delivery waits visibly in its inbox."
        />

        <section class="space-y-4 rounded-lg border border-default p-4">
          <div>
            <h2 class="text-sm font-semibold">New scheduled task</h2>
            <p class="text-xs text-muted">Use a standard five-field cron expression or choose one exact time.</p>
          </div>
          <div v-if="!agents.length" class="text-sm text-muted">Create a coding agent before scheduling work.</div>
          <template v-else>
            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField label="Agent">
                <USelectMenu
                  v-model="form.agentSessionId"
                  :items="agentItems"
                  value-key="value"
                  placeholder="Choose an agent"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="Task name">
                <UInput v-model="form.name" class="w-full" placeholder="Review open pull requests" />
              </UFormField>
            </div>
            <UFormField label="Prompt">
              <UTextarea v-model="form.prompt" class="w-full" :rows="3" placeholder="Check the repository and…" />
            </UFormField>
            <div class="grid gap-3 sm:grid-cols-5">
              <UFormField label="Schedule">
                <USelect v-model="scheduleType" :items="scheduleItems" value-key="value" class="w-full" />
              </UFormField>
              <UFormField label="If busy">
                <USelect v-model="form.delivery" :items="deliveryItems" value-key="value" class="w-full" />
              </UFormField>
              <UFormField v-if="scheduleType === 'cron'" label="Cron expression" class="sm:col-span-2">
                <UInput v-model="form.cronExpression" class="w-full font-mono" />
              </UFormField>
              <UFormField v-if="scheduleType === 'cron'" label="Time zone">
                <UInput v-model="form.timezone" class="w-full" />
              </UFormField>
              <UFormField v-else label="Run at" class="sm:col-span-3">
                <UInput v-model="form.runAt" type="datetime-local" class="w-full" />
              </UFormField>
            </div>
            <div class="flex justify-end">
              <UButton label="Schedule task" icon="i-lucide-calendar-plus" :loading="saving" :disabled="!form.agentSessionId || !form.name.trim() || !form.prompt.trim()" @click="createJob" />
            </div>
          </template>
        </section>

        <section v-if="!jobs.length" class="rounded-lg border border-dashed border-default p-8 text-center">
          <UIcon name="i-lucide-calendar-clock" class="mx-auto size-8 text-dimmed" />
          <p class="mt-2 text-sm text-muted">No tasks are scheduled yet.</p>
        </section>

        <section v-else class="space-y-2">
          <article v-for="job in jobs" :key="job.id" class="rounded-lg border border-default p-4">
            <div class="flex items-start gap-3">
              <UIcon :name="job.enabled ? 'i-lucide-clock-3' : 'i-lucide-pause'" class="mt-0.5 size-5 text-primary" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="text-sm font-semibold">{{ job.name }}</h2>
                  <UBadge color="neutral" variant="subtle" :label="agentName(job.agentSessionId)" />
                  <UBadge v-if="job.lastStatus" :color="job.lastStatus === 'failed' ? 'error' : 'success'" variant="subtle" :label="job.lastStatus" />
                </div>
                <p class="mt-1 line-clamp-2 text-sm text-muted">{{ job.prompt }}</p>
                <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-dimmed">
                  <span v-if="job.scheduleType === 'cron'" class="font-mono">{{ job.cronExpression }} · {{ job.timezone }}</span>
                  <span>Next: {{ when(job) }}</span>
                  <span>{{ job.runCount }} runs</span>
                </div>
                <p v-if="job.lastError" class="mt-2 text-xs text-error">{{ job.lastError }}</p>
              </div>
              <UButton :icon="job.enabled ? 'i-lucide-pause' : 'i-lucide-play'" color="neutral" variant="ghost" size="sm" @click="toggle(job)" />
              <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" @click="askToRemove(job)" />
            </div>
          </article>
        </section>
      </div>

      <UModal
        v-model:open="deleteOpen"
        title="Delete scheduled task"
        :description="deletingJob ? `Delete “${deletingJob.name}”? This cannot be undone.` : 'Delete this scheduled task?'"
      >
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton label="Cancel" color="neutral" variant="ghost" @click="deleteOpen = false" />
            <UButton label="Delete" color="error" icon="i-lucide-trash-2" @click="remove" />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
