import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp, UPopover } from '#components'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import TargetSchedules from '~/components/TargetSchedules.vue'
import type { CronJob } from '~~/shared/types'

const rows = ref<CronJob[]>([])
mockNuxtImport('useCronJobs', () => () => ({ jobs: computed(() => rows.value), isReady: ref(true) }))

const toasts = vi.fn()
mockNuxtImport('useToast', () => () => ({ add: toasts }))

const ran = vi.fn()
registerEndpoint('/api/cron-jobs/cron_mine/run', {
  method: 'POST',
  handler: () => {
    ran()
    return { jobId: 'cron_mine', agentSessionId: 'ag_1', delivery: 'queue', outcome: 'queued' }
  }
})

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron_mine',
    agentSessionId: 'ag_1',
    assistantId: null,
    name: 'Morning review',
    prompt: 'Review.',
    scheduleType: 'cron',
    cronExpression: '0 9 * * 1-5',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    runAt: null,
    enabled: true,
    delivery: 'queue',
    nextRunAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    createdBy: 'user',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  }
}

const mounted: { unmount: () => void }[] = []
async function mount(props: { agentSessionId?: string, assistantId?: string }) {
  const component = await mountSuspended(defineComponent(() => () => h(UApp, null, { default: () => h(TargetSchedules, props) })))
  mounted.push(component)
  return component
}

async function openPopover(component: Awaited<ReturnType<typeof mount>>) {
  component.findComponent(UPopover).vm.$emit('update:open', true)
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  rows.value = []
  toasts.mockClear()
  ran.mockClear()
})

afterEach(() => {
  for (const component of mounted.splice(0)) component.unmount()
})

describe('TargetSchedules', () => {
  it('offers only a quiet way to add one when nothing is scheduled', async () => {
    rows.value = [job({ agentSessionId: 'ag_other' })]
    const component = await mount({ agentSessionId: 'ag_1' })

    const add = component.find('[aria-label="Add a schedule"]')
    expect(add.attributes('href')).toBe('/schedules?target=ag_1')
    expect(component.findComponent(UPopover).exists()).toBe(false)
  })

  it('counts and lists the session\'s own tasks and its assistant\'s, and nobody else\'s', async () => {
    rows.value = [
      job(),
      job({ id: 'cron_assistant', agentSessionId: null, assistantId: 'as_1', name: 'Assistant sweep', enabled: false, nextRunAt: null }),
      job({ id: 'cron_other', agentSessionId: 'ag_other', name: 'Not mine' })
    ]
    const component = await mount({ agentSessionId: 'ag_1', assistantId: 'as_1' })

    expect(component.find('[aria-label="2 scheduled tasks"]').exists()).toBe(true)
    await openPopover(component)
    const text = document.body.textContent!
    expect(text).toContain('Morning review')
    expect(text).toContain('Weekdays at')
    expect(text).toContain('Next in 3h')
    expect(text).toContain('Assistant sweep')
    expect(text).toContain('Paused')
    expect(text).not.toContain('Not mine')
    expect(document.querySelector('a[href="/schedules?edit=cron_mine"]')).not.toBeNull()
    // A new one from here is for the assistant, so it outlives the session.
    expect(document.querySelector('a[href="/schedules?target=as_1"]')).not.toBeNull()
  })

  it('shows the last run and why it failed', async () => {
    rows.value = [job({ lastRunAt: new Date(Date.now() - 2 * 3600_000).toISOString(), lastStatus: 'failed', lastError: 'adapter would not start', runCount: 1 })]
    const component = await mount({ agentSessionId: 'ag_1' })
    await openPopover(component)

    expect(document.body.textContent).toContain('Last 2h ago')
    expect(document.body.textContent).toContain('Failed')
    expect(document.body.textContent).toContain('adapter would not start')
  })

  it('runs a task now and says what became of it', async () => {
    rows.value = [job()]
    const component = await mount({ agentSessionId: 'ag_1' })
    await openPopover(component)

    ;(document.querySelector('button[aria-label="Run now"]') as HTMLButtonElement).click()

    await vi.waitFor(() => expect(toasts).toHaveBeenCalled())
    expect(ran).toHaveBeenCalledTimes(1)
    expect(toasts.mock.calls[0]![0]).toMatchObject({
      title: 'Ran “Morning review”',
      description: 'Queued: it runs when the current turn ends.',
      color: 'success'
    })
  })
})
