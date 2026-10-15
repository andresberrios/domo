<script setup lang="ts">
import type { CronJob } from '~~/shared/types'

/**
 * The scheduled tasks that wake one agent page's target, behind a small
 * button in its toolbar. An assistant's current session passes both ids: what
 * is scheduled for the assistant lands in that session.
 */
const props = defineProps<{
  agentSessionId?: string | null
  assistantId?: string | null
}>()

const { jobs: allJobs } = useCronJobs()
const { running, runNow } = useRunCronJob()
const open = ref(false)
/** Tasks whose prompt is shown; collapsed, the list stays one glance tall. */
const expanded = ref(new Set<string>())

function toggle(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

// Archived tasks are put away: the Schedules page shows them on request.
const jobs = computed(() => allJobs.value.filter(job => !job.archived && (
  (!!props.agentSessionId && job.agentSessionId === props.agentSessionId)
  || (!!props.assistantId && job.assistantId === props.assistantId)
)))
const active = computed(() => jobs.value.filter(job => job.enabled).length)
// A new schedule for an assistant's session is for the assistant, so it
// outlives the session.
const addTo = computed(() => `/schedules?target=${props.assistantId ?? props.agentSessionId}`)

const STATUS: Record<string, { label: string, color: 'success' | 'error' | 'neutral' }> = {
  delivered: { label: 'Delivered', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
  running: { label: 'Running', color: 'neutral' }
}

function next(job: CronJob) {
  if (!job.enabled) return job.scheduleType === 'once' && job.lastRunAt && !job.nextRunAt ? 'Done' : 'Paused'
  return job.nextRunAt ? `Next ${timeUntil(job.nextRunAt)}` : 'No next run'
}
</script>

<template>
  <UTooltip v-if="!jobs.length" text="Add a schedule">
    <UButton
      icon="i-lucide-calendar-plus"
      color="neutral"
      variant="ghost"
      size="xs"
      aria-label="Add a schedule"
      :to="addTo"
    />
  </UTooltip>
  <UPopover v-else v-model:open="open" :content="{ align: 'start' }">
    <UButton
      icon="i-lucide-clock-3"
      :color="active ? 'primary' : 'neutral'"
      variant="ghost"
      size="xs"
      :label="String(jobs.length)"
      :aria-label="`${jobs.length} scheduled task${jobs.length === 1 ? '' : 's'}`"
    />
    <template #content>
      <div class="w-80 max-w-[calc(100vw-2rem)]">
        <ul class="max-h-96 divide-y divide-default overflow-y-auto">
          <li v-for="job in jobs" :key="job.id" class="space-y-1 p-3">
            <div class="flex items-center gap-2">
              <UIcon
                :name="job.enabled ? 'i-lucide-clock-3' : 'i-lucide-pause'"
                :class="job.enabled ? 'text-primary' : 'text-dimmed'"
                class="size-4 shrink-0"
              />
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1 text-start text-sm font-medium"
                :class="{ 'text-muted': !job.enabled }"
                :aria-expanded="expanded.has(job.id)"
                :aria-label="`${expanded.has(job.id) ? 'Hide' : 'Show'} the prompt of ${job.name}`"
                @click="toggle(job.id)"
              >
                <span class="truncate">{{ job.name }}</span>
                <UIcon
                  name="i-lucide-chevron-down"
                  class="size-3.5 shrink-0 text-dimmed transition-transform"
                  :class="{ 'rotate-180': expanded.has(job.id) }"
                />
              </button>
              <UTooltip text="Run now">
                <UButton
                  icon="i-lucide-play"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  aria-label="Run now"
                  :loading="running === job.id"
                  :disabled="!!running"
                  @click="runNow(job)"
                />
              </UTooltip>
              <UTooltip text="Edit">
                <UButton
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  aria-label="Edit"
                  :to="`/schedules?edit=${job.id}`"
                  @click="open = false"
                />
              </UTooltip>
            </div>
            <p class="ps-6 text-xs text-muted">
              {{ scheduleInWords(job) }}<span v-if="job.assistantId && agentSessionId"> · for the assistant</span>
            </p>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 ps-6 text-xs text-dimmed">
              <span>{{ next(job) }}</span>
              <template v-if="job.lastRunAt">
                <span>·</span>
                <span>Last {{ relativeTime(job.lastRunAt) }}</span>
                <UBadge
                  v-if="job.lastStatus"
                  :color="STATUS[job.lastStatus]?.color ?? 'neutral'"
                  variant="subtle"
                  size="sm"
                  :label="STATUS[job.lastStatus]?.label ?? job.lastStatus"
                />
              </template>
            </div>
            <p v-if="job.lastError" class="line-clamp-2 ps-6 text-xs text-error">{{ job.lastError }}</p>
            <SchedulePrompt v-if="expanded.has(job.id)" :text="job.prompt" class="ms-6 mt-2" />
          </li>
        </ul>
        <div class="flex items-center justify-between border-t border-default p-2">
          <UButton label="Add a schedule" icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" :to="addTo" @click="open = false" />
          <UButton label="All schedules" color="neutral" variant="link" size="xs" to="/schedules" @click="open = false" />
        </div>
      </div>
    </template>
  </UPopover>
</template>
