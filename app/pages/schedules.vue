<script setup lang="ts">
import type { CronJob } from '~~/shared/types'

const toast = useToast()
const route = useRoute()
const router = useRouter()
// `agents` is who you may schedule *for*; `all` is who a job may point *at*.
// Retiring an environment disables its sessions' jobs but leaves them in this
// list, and a row naming a bare id rather than the agent reads as a bug.
const { sessions: everySession, all: allAgents } = useAgentSessions()
// An assistant is scheduled as itself, so the job survives its handoffs; its
// sessions are not offered on their own.
const { assistants, all: allAssistants } = useAssistants()
const agents = computed(() => everySession.value.filter(agent => !agent.assistantId))
const { jobs } = useCronJobs()
const { running, runNow } = useRunCronJob()
const saving = ref(false)
/** The job the form is editing, or null when it makes a new one. */
const editing = ref<CronJob | null>(null)
const formSection = ref<HTMLElement | null>(null)
/** Jobs whose whole prompt is shown instead of its first two lines. */
const expanded = ref(new Set<string>())

function togglePrompt(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}
const deleteOpen = ref(false)
const deletingJob = ref<CronJob | null>(null)
const scheduleType = ref<'cron' | 'once'>('cron')
const scheduleItems = [
  { label: 'Recurring', value: 'cron' },
  { label: 'One time', value: 'once' }
]
const deliveryItems = [
  { label: 'Wait for the turn to end', value: 'queue' },
  { label: 'Join the running turn', value: 'steer' },
  { label: 'Stop the turn and start', value: 'interrupt' }
]

const STATUS_LABELS: Record<string, string> = { running: 'Running', delivered: 'Delivered', failed: 'Failed' }
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
  if (!form.agentSessionId) form.agentSessionId = assistants.value[0]?.id ?? agents.value[0]?.id ?? ''
})

// An agent's page links here to add a schedule for it (`?target=`) or edit one
// of its own (`?edit=`).
watch(() => route.query.target, (target) => {
  if (typeof target === 'string' && target) form.agentSessionId = target
}, { immediate: true })
watch([() => route.query.edit, jobs], ([id]) => {
  if (typeof id !== 'string' || editing.value?.id === id) return
  const job = jobs.value.find(item => item.id === id)
  if (job) edit(job)
}, { immediate: true })

/** `datetime-local` wants local wall time, without a zone. */
function localInput(iso: string) {
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function edit(job: CronJob) {
  editing.value = job
  form.agentSessionId = job.assistantId ?? job.agentSessionId ?? ''
  form.name = job.name
  form.prompt = job.prompt
  form.delivery = job.delivery
  scheduleType.value = job.scheduleType
  if (job.scheduleType === 'cron') {
    form.cronExpression = job.cronExpression ?? ''
    form.timezone = job.timezone
  } else {
    form.runAt = job.runAt ? localInput(job.runAt) : ''
  }
  nextTick(() => formSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

function stopEditing() {
  editing.value = null
  form.name = ''
  form.prompt = ''
  if (route.query.edit) void router.replace({ query: { ...route.query, edit: undefined } })
}

/** Assistants first: they are who recurring work is usually for. Ids say which is which. */
const agentItems = computed(() => [
  ...assistants.value.map(assistant => ({ label: assistant.name, value: assistant.id, icon: 'i-lucide-sparkles' })),
  ...agents.value.map(agent => ({ label: agent.title, value: agent.id, icon: 'i-lucide-bot' }))
])

function targetName(job: CronJob) {
  if (job.assistantId) {
    const assistant = allAssistants.value.find(item => item.id === job.assistantId)
    if (!assistant) return job.assistantId
    return assistant.archived ? `${assistant.name} (archived)` : assistant.name
  }
  const agent = allAgents.value.find(item => item.id === job.agentSessionId)
  if (!agent) return job.agentSessionId ?? ''
  return agent.archived ? `${agent.title} (archived)` : agent.title
}

function when(job: CronJob) {
  // A one-time job run now is still due at its time.
  if (job.scheduleType === 'once' && job.lastRunAt && !job.nextRunAt) {
    return `Ran ${new Date(job.lastRunAt).toLocaleString()}`
  }
  if (!job.enabled) return 'Paused'
  if (!job.nextRunAt) return 'No next run'
  return `Next: ${new Date(job.nextRunAt).toLocaleString()}`
}

async function save() {
  if (!form.agentSessionId || !form.name.trim() || !form.prompt.trim()) return
  saving.value = true
  const job = editing.value
  try {
    const runAt = scheduleType.value === 'once' ? new Date(form.runAt).toISOString() : null
    await $fetch(job ? `/api/cron-jobs/${job.id}` : '/api/cron-jobs', {
      method: job ? 'PATCH' : 'POST',
      body: {
        ...form.agentSessionId.startsWith('as_')
          ? { assistantId: form.agentSessionId }
          : { agentSessionId: form.agentSessionId },
        name: form.name,
        prompt: form.prompt,
        delivery: form.delivery,
        ...(scheduleType.value === 'cron'
          ? { cronExpression: form.cronExpression, timezone: form.timezone }
          // A finished one-time task given a new time is meant to run at it.
          : { runAt, ...job && runAt !== job.runAt ? { enabled: true } : {} })
      }
    })
    if (job) stopEditing()
    else {
      form.name = ''
      form.prompt = ''
    }
    toast.add({ title: job ? 'Task updated' : 'Task scheduled', color: 'success' })
  } catch (error: any) {
    toast.add({ title: job ? 'Could not update task' : 'Could not schedule task', description: error?.data?.statusMessage ?? error?.message, color: 'error' })
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
  if (editing.value?.id === deletingJob.value.id) stopEditing()
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
          description="Schedules keep running across Domo restarts. “If busy” decides what happens when the agent is mid-turn as one fires."
        />

        <section ref="formSection" class="scroll-mt-4 space-y-4 rounded-lg border p-4" :class="editing ? 'border-primary' : 'border-default'">
          <div>
            <h2 class="text-sm font-semibold">{{ editing ? `Edit “${editing.name}”` : 'New scheduled task' }}</h2>
            <p class="text-xs text-muted">Use a standard five-field cron expression or choose one exact time.</p>
          </div>
          <div v-if="!agentItems.length" class="text-sm text-muted">Create an assistant or a coding agent before scheduling work.</div>
          <template v-else>
            <div class="grid gap-3 sm:grid-cols-2">
              <UFormField label="Send to">
                <ChoiceMenu
                  v-model="form.agentSessionId"
                  :items="agentItems"
                  value-key="value"
                  placeholder="Choose an assistant or agent"
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
            <div class="flex justify-end gap-2">
              <UButton v-if="editing" label="Cancel" color="neutral" variant="ghost" @click="stopEditing" />
              <UButton
                :label="editing ? 'Save changes' : 'Schedule task'"
                :icon="editing ? 'i-lucide-check' : 'i-lucide-calendar-plus'"
                :loading="saving"
                :disabled="!form.agentSessionId || !form.name.trim() || !form.prompt.trim()"
                @click="save"
              />
            </div>
          </template>
        </section>

        <section v-if="!jobs.length" class="rounded-lg border border-dashed border-default p-8 text-center">
          <UIcon name="i-lucide-calendar-clock" class="mx-auto size-8 text-dimmed" />
          <p class="mt-2 text-sm text-muted">No tasks are scheduled yet.</p>
        </section>

        <section v-else class="space-y-2">
          <article v-for="job in jobs" :key="job.id" class="rounded-lg border p-4" :class="editing?.id === job.id ? 'border-primary' : 'border-default'">
            <div class="flex items-start gap-3">
              <UIcon :name="job.enabled ? 'i-lucide-clock-3' : 'i-lucide-pause'" class="mt-0.5 size-5 text-primary" />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="text-sm font-semibold">{{ job.name }}</h2>
                  <UBadge color="neutral" variant="subtle" :label="targetName(job)" />
                  <UBadge v-if="job.lastStatus" :color="job.lastStatus === 'failed' ? 'error' : job.lastStatus === 'delivered' ? 'success' : 'neutral'" variant="subtle" :label="STATUS_LABELS[job.lastStatus] ?? job.lastStatus" />
                </div>
                <SchedulePrompt v-if="expanded.has(job.id)" :text="job.prompt" class="mt-2" />
                <button
                  v-else
                  type="button"
                  class="mt-1 line-clamp-2 w-full text-start text-sm whitespace-pre-line text-muted hover:text-default"
                  :aria-label="`Show the whole prompt of ${job.name}`"
                  @click="togglePrompt(job.id)"
                  v-text="job.prompt"
                />
                <UButton
                  v-if="expanded.has(job.id)"
                  label="Show less"
                  icon="i-lucide-chevron-up"
                  color="neutral"
                  variant="link"
                  size="xs"
                  class="mt-1 px-0"
                  @click="togglePrompt(job.id)"
                />
                <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-dimmed">
                  <span v-if="job.scheduleType === 'cron'">{{ scheduleInWords(job) }} · <span class="font-mono">{{ job.cronExpression }}</span></span>
                  <span>{{ when(job) }}</span>
                  <span>{{ job.runCount === 1 ? '1 run' : `${job.runCount} runs` }}</span>
                </div>
                <p v-if="job.lastError" class="mt-2 text-xs text-error">{{ job.lastError }}</p>
              </div>
              <div class="flex shrink-0 flex-wrap justify-end gap-1">
                <UButton
                  label="Run now"
                  aria-label="Run now"
                  icon="i-lucide-play"
                  color="neutral"
                  variant="soft"
                  size="sm"
                  :loading="running === job.id"
                  :disabled="!!running"
                  :ui="{ label: 'hidden sm:inline' }"
                  @click="runNow(job)"
                />
                <UTooltip text="Edit">
                  <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" aria-label="Edit" @click="edit(job)" />
                </UTooltip>
                <UTooltip :text="job.enabled ? 'Pause' : 'Resume'">
                  <UButton :icon="job.enabled ? 'i-lucide-pause' : 'i-lucide-calendar-check'" color="neutral" variant="ghost" size="sm" :aria-label="job.enabled ? 'Pause' : 'Resume'" @click="toggle(job)" />
                </UTooltip>
                <UTooltip text="Delete">
                  <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" aria-label="Delete" @click="askToRemove(job)" />
                </UTooltip>
              </div>
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
