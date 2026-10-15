import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { UApp } from '#components'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SchedulesPage from '~/pages/schedules.vue'
import type { CronJob } from '~~/shared/types'

let agentRows: any[] = []
let jobRows: CronJob[] = []
let assistantRows: any[] = []

mockNuxtImport('useAgentSessions', () => () => ({
  sessions: computed(() => agentRows.filter(row => !row.archived)),
  all: computed(() => agentRows),
  isReady: ref(true)
}))

mockNuxtImport('useAssistants', () => () => ({
  assistants: computed(() => assistantRows.filter(row => !row.archived)),
  all: computed(() => assistantRows),
  isReady: ref(true)
}))

mockNuxtImport('useCronJobs', () => () => ({
  jobs: computed(() => jobRows),
  isReady: ref(true)
}))

const patched: any[] = []
registerEndpoint('/api/cron-jobs/cron_1', {
  method: 'PATCH',
  handler: async (event) => {
    patched.push(await readBody(event))
    return { id: 'cron_1' }
  }
})

const ran: string[] = []
registerEndpoint('/api/cron-jobs/cron_1/run', {
  method: 'POST',
  handler: () => {
    ran.push('cron_1')
    return { jobId: 'cron_1', agentSessionId: 'ag_chosen', delivery: 'steer', outcome: 'steered' }
  }
})

const posted: any[] = []
registerEndpoint('/api/cron-jobs', {
  method: 'POST',
  handler: async (event) => {
    posted.push(await readBody(event))
    return { id: 'cron_new' }
  }
})

// The page's tooltips need the app's providers around it.
const Page = defineComponent(() => () => h(UApp, null, { default: () => h(SchedulesPage) }))
const mountPage = (route = '/schedules') => mountSuspended(Page, { attachTo: document.body, route })

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'cron_1',
    agentSessionId: 'ag_chosen',
    assistantId: null,
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
  patched.length = 0
  ran.length = 0
  document.body.innerHTML = ''
})

describe('schedules page', () => {
  it('posts a recurring prompt for the chosen agent', async () => {
    const wrapper = await mountPage()
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
    const wrapper = await mountPage()

    expect(document.body.textContent).toContain('Paused')
    expect(document.body.textContent).toContain('Ran ')
    wrapper.unmount()
  })

  it('explains that an agent is required when the list is empty', async () => {
    agentRows = []
    const wrapper = await mountPage()

    expect(document.body.textContent).toContain('Create an assistant or a coding agent before scheduling work.')
    wrapper.unmount()
  })

  it('schedules an assistant as itself, so the job outlives its sessions', async () => {
    agentRows = [{ id: 'ag_of_assistant', title: 'Inbox organizer', archived: false, assistantId: 'as_1' }]
    assistantRows = [{ id: 'as_1', name: 'Inbox organizer', archived: false }]
    const wrapper = await mountPage()

    // Preselected as the target, ahead of every session.
    expect(document.body.textContent).toContain('Inbox organizer')
    const name = document.querySelector('input[placeholder="Review open pull requests"]') as HTMLInputElement
    const prompt = document.querySelector('textarea') as HTMLTextAreaElement
    name.value = 'Morning sweep'
    name.dispatchEvent(new Event('input'))
    prompt.value = 'Sort the inbox.'
    prompt.dispatchEvent(new Event('input'))
    await nextTick()
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.includes('Schedule task'))!.click()
    await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ assistantId: 'as_1', name: 'Morning sweep' }))
    expect(posted.at(-1).agentSessionId).toBeUndefined()
    wrapper.unmount()
    assistantRows = []
  })

  it('runs a task now from its row', async () => {
    jobRows = [job()]
    const wrapper = await mountPage()

    await wrapper.findAll('button').find(button => button.text().includes('Run now'))!.trigger('click')

    await vi.waitFor(() => expect(ran).toEqual(['cron_1']))
    wrapper.unmount()
  })

  it('keeps showing when a one-time task is due after it was run early', async () => {
    jobRows = [job({
      scheduleType: 'once', cronExpression: null, runAt: '2099-01-01T10:00:00.000Z',
      nextRunAt: '2099-01-01T10:00:00.000Z', lastRunAt: '2026-09-21T10:00:00.000Z', runCount: 1
    })]
    const wrapper = await mountPage()

    expect(document.body.textContent).toContain('Next: ')
    expect(document.body.textContent).not.toContain('Ran ')
    wrapper.unmount()
  })

  it('opens a task for editing from a link and saves it in place', async () => {
    jobRows = [job({ delivery: 'interrupt' })]
    const wrapper = await mountPage('/schedules?edit=cron_1')

    await vi.waitFor(() => expect(document.body.textContent).toContain('Edit “Review CI”'))
    const name = wrapper.find('input[placeholder="Review open pull requests"]')
    expect((name.element as HTMLInputElement).value).toBe('Review CI')
    await name.setValue('Review CI twice')
    await wrapper.findAll('button').find(button => button.text().includes('Save changes'))!.trigger('click')

    await vi.waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({
      agentSessionId: 'ag_chosen', name: 'Review CI twice', prompt: 'Inspect CI.', delivery: 'interrupt', cronExpression: '0 9 * * 1-5'
    })
    expect(posted).toHaveLength(0)
    await vi.waitFor(() => expect(useRouter().currentRoute.value.query.edit).toBeUndefined())
    wrapper.unmount()
  })

  it('opens a clamped prompt in full, and folds it again', async () => {
    jobRows = [job({ prompt: 'Step one\nStep two\nStep three\n\nUse `pnpm test`.' })]
    const wrapper = await mountPage()

    expect(document.querySelector('.md-body')).toBeNull()
    ;(document.querySelector('button[aria-label="Show the whole prompt of Review CI"]') as HTMLButtonElement).click()

    await expect.poll(() => document.querySelector('.md-body code')?.textContent).toBe('pnpm test')
    expect(document.querySelector('.md-body')!.textContent).toContain('Step three')
    expect(document.querySelector('button[aria-label="Copy prompt"]')).not.toBeNull()

    await wrapper.findAll('button').find(button => button.text().includes('Show less'))!.trigger('click')
    expect(document.querySelector('.md-body')).toBeNull()
    wrapper.unmount()
  })
})

