import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp, USlideover } from '#components'
import { readBody } from 'h3'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import NotificationsButton from '~/components/NotificationsButton.vue'
import type { DomoNotification } from '~~/shared/types'

/**
 * What an agent asked the human to see stays until it is marked seen; a toast
 * is only for one that arrives while the page is open, never the backlog.
 */

const rows = ref<DomoNotification[]>([])
mockNuxtImport('useNotifications', () => () => ({
  notifications: rows,
  unseen: computed(() => rows.value.filter(row => !row.seenAt)),
  isReady: ref(true)
}))

const toasts = vi.fn()
mockNuxtImport('useToast', () => () => ({ add: toasts }))

const seen = vi.fn()
registerEndpoint('/api/notifications/seen', {
  method: 'POST',
  handler: async (event: any) => {
    seen(await readBody(event))
    return { seen: 1 }
  }
})

function notification(overrides: Partial<DomoNotification> = {}): DomoNotification {
  return {
    id: 'nt_1',
    agentSessionId: 'ag_1',
    agentTitle: 'watcher',
    message: 'A new adapter release is out.',
    urgent: false,
    attachments: [],
    createdAt: new Date().toISOString(),
    seenAt: null,
    ...overrides
  }
}

const Harness = defineComponent(() => () => h(UApp, null, { default: () => h(NotificationsButton) }))

beforeEach(() => {
  rows.value = []
  toasts.mockClear()
  seen.mockClear()
})

describe('NotificationsButton', () => {
  it('counts what is unseen, and toasts only what arrives after the page opened', async () => {
    rows.value = [notification({ id: 'nt_old', createdAt: '2026-01-01T00:00:00.000Z' })]
    const component = await mountSuspended(Harness)

    expect(component.find('[aria-label="Notifications (1 unseen)"]').exists()).toBe(true)
    expect(toasts).not.toHaveBeenCalled()

    rows.value = [...rows.value, notification({ id: 'nt_new', urgent: true })]
    await nextTick()

    expect(toasts).toHaveBeenCalledTimes(1)
    expect(toasts.mock.calls[0]![0]).toMatchObject({ title: 'watcher (urgent)', color: 'error', duration: 0 })
  })

  it('shows the message and its files, and marks one seen', async () => {
    rows.value = [notification({
      attachments: [{ name: 'shot.png', mimeType: 'image/png', size: 2048 }, { name: 'run.log', mimeType: 'text/plain', size: 10 }]
    })]
    const component = await mountSuspended(Harness)
    component.findComponent(USlideover).vm.$emit('update:open', true)
    await nextTick()

    const body = document.body
    // `MarkdownView` renders asynchronously.
    await expect.poll(() => body.textContent).toContain('A new adapter release is out.')
    expect(body.querySelector('img[src="/api/notifications/nt_1/attachments/0"]')).not.toBeNull()
    expect(body.textContent).toContain('run.log (10 B)')

    ;(body.querySelector('[aria-label="Mark seen"]') as HTMLElement).click()
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith({ ids: ['nt_1'] }))
  })
})
