import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SchedulesPage from '~/pages/schedules.vue'
import type { CronJob } from '~~/shared/types'

let agentRows: any[] = []
let jobRows: CronJob[] = []

mockNuxtImport('useAgentSessions', () => () => ({
  sessions: computed(() => agentRows),
  isReady: ref(true)
}))

mockNuxtImport('useCronJobs', () => () => ({
  jobs: computed(() => jobRows),
  isReady: ref(true)
}))

const posted: any[] = []
registerEndpoint('/api/cron-jobs', {
  method: 'POST',
  handler: async (event) => {
    posted.push(await readBody(event))
    return { id: 'cron_new' }
  }
})

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron_1',
    agentSessionId: 'ag_chosen',
    name: 'Review CI',
    prompt: 'Inspect CI.',
    scheduleType: 'cron',
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    runAt: null,
    enabled: true,
    delivery: 'queue',
    nextRunAt: '2026-09-23T09:00:00.000Z',
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    runCount: 0,
    createdBy: 'user',
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  agentRows = [{ id: 'ag_chosen', title: 'Chosen agent' }]
  jobRows = []
  posted.length = 0
  document.body.innerHTML = ''
})

describe('schedules page', () => {
  it('posts a recurring prompt for the chosen agent', async () => {
    const wrapper = await mountSuspended(SchedulesPage, { attachTo: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Chosen agent'))

    await wrapper.find('input[placeholder="Review open pull requests"]').setValue('Morning review')
    await wrapper.find('textarea[placeholder="Check the repository and…"]').setValue('Inspect CI and fix it.')
    await wrapper.findAll('button').find(button => button.text().includes('Schedule task'))!.trigger('click')

    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({
      agentSessionId: 'ag_chosen',
      name: 'Morning review',
      prompt: 'Inspect CI and fix it.',
      cronExpression: '0 9 * * 1-5',
      delivery: 'queue'
    })
    wrapper.unmount()
  })

  it('distinguishes a paused job from a completed one-time job', async () => {
    jobRows = [
      job({ id: 'cron_paused', name: 'Paused task', enabled: false, nextRunAt: null }),
      job({
        id: 'cron_done',
        name: 'Finished once',
        scheduleType: 'once',
        cronExpression: null,
        runAt: '2026-09-21T10:00:00.000Z',
        enabled: false,
        nextRunAt: null,
        lastRunAt: '2026-09-21T10:00:00.000Z',
        runCount: 1
      })
    ]
    const wrapper = await mountSuspended(SchedulesPage, { attachTo: document.body })

    expect(document.body.textContent).toContain('Paused')
    expect(document.body.textContent).toContain('Ran ')
    wrapper.unmount()
  })

  it('explains that an agent is required when the list is empty', async () => {
    agentRows = []
    const wrapper = await mountSuspended(SchedulesPage, { attachTo: document.body })

    expect(document.body.textContent).toContain('Create a coding agent before scheduling work.')
    wrapper.unmount()
  })
})
