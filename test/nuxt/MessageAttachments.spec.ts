import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AgentComposer from '~/components/AgentComposer.vue'
import MessageAttachments from '~/components/MessageAttachments.vue'
import type { AgentSession } from '~~/shared/types'

/**
 * Attachments are seen, not just named: images as thumbnails that open full
 * size, in the composer and under a sent message alike, each one under a
 * name of its own.
 */
enableAutoUnmount(afterEach)

const UP_1 = 'up_00000000000000000001'
const UP_2 = 'up_00000000000000000002'

const Attachments = defineComponent({
  props: { attachments: { type: Array as () => any[], required: true } },
  setup: props => () => h(UApp, null, { default: () => h(MessageAttachments, { attachments: props.attachments }) })
})

describe('MessageAttachments', () => {
  const sent = [
    { name: 'image-1.png', uri: `file:///data/uploads/${UP_1}.png` },
    { name: 'image-2.png', uri: `file:///data/uploads/${UP_2}.png` },
    { name: 'notes.pdf', uri: 'file:///data/uploads/up_00000000000000000003.pdf' },
    // An image that is not one of Domo's uploads has nothing to show from.
    { name: 'elsewhere.png', uri: 'file:///home/someone/elsewhere.png' }
  ]

  it('shows uploaded images as thumbnails and everything else by name', async () => {
    const component = await mountSuspended(Attachments, { props: { attachments: sent } })

    const thumbnails = component.findAll('img')
    expect(thumbnails.map(img => img.attributes('src'))).toEqual([`/api/uploads/${UP_1}.png`, `/api/uploads/${UP_2}.png`])
    expect(component.text()).toContain('notes.pdf')
    expect(component.text()).toContain('elsewhere.png')
    // A sent message's attachments are a record: nothing to remove.
    expect(component.find('button[aria-label^="Remove"]').exists()).toBe(false)
  })

  it('opens the one tapped full size, and steps to the next', async () => {
    const component = await mountSuspended(Attachments, { props: { attachments: sent } })

    await component.find('button[aria-label="Open image-2.png"]').trigger('click')
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(`/api/uploads/${UP_2}.png`))
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2 of 2')

    ;(document.querySelector('[role="dialog"] button[aria-label="Next image"]') as HTMLElement).click()
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe(`/api/uploads/${UP_1}.png`))
  })
})

/**
 * The names the composer gave its uploads. Read off `FormData.append`, because
 * a multipart body does not survive the test runtime's fetch; the endpoint
 * answers with the files named so far and not yet answered.
 */
const named = vi.fn()
let unanswered: string[] = []
let serial = 0
const append = FormData.prototype.append
vi.spyOn(FormData.prototype, 'append').mockImplementation(function (this: FormData, key: string, value: any, filename?: string) {
  if (key === 'files' && filename) {
    named(filename)
    unanswered.push(filename)
  }
  return (append as any).call(this, key, value, filename)
})

registerEndpoint('/api/uploads', {
  method: 'POST',
  handler: () => {
    const names = unanswered
    unanswered = []
    return {
      files: names.map((name) => {
        serial += 1
        return { name, path: `/data/uploads/up_${String(serial).padStart(20, '0')}.png`, mimeType: 'image/png', size: 1 }
      })
    }
  }
})

const session = { id: 'ag_att', adapter: 'claude-code', status: 'idle', cwd: '/w', usage: null, steering: null } as unknown as AgentSession

/** What the server says the conversation has already used. */
let used: string[] = []
registerEndpoint('/api/agents/ag_att/attachment-names', { method: 'GET', handler: () => ({ names: used }) })

const Composer = defineComponent({
  setup: () => () => h(UApp, null, { default: () => h(AgentComposer, { session }) })
})

function paste(component: any, files: File[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '' } })
  component.find('textarea').element.dispatchEvent(event)
}

const screenshot = () => new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })

describe('AgentComposer attachments', () => {
  beforeEach(() => {
    named.mockClear()
    used = []
    localStorage.clear()
  })

  it('numbers pasted screenshots across the message and past the names the session has used', async () => {
    // Whatever the page has loaded: the server is asked, and it knows the whole conversation.
    used = ['image-1.png']
    const component = await mountSuspended(Composer)

    paste(component, [screenshot(), screenshot()])
    paste(component, [screenshot()])

    await vi.waitFor(() => expect(named).toHaveBeenCalledTimes(3))
    expect(named.mock.calls.map(call => call[0])).toEqual(['image-2.png', 'image-3.png', 'image-4.png'])
  })

  it('shows them as thumbnails, each with a way to take it off', async () => {
    const component = await mountSuspended(Composer)

    paste(component, [screenshot(), screenshot()])
    await vi.waitFor(() => expect(component.findAll('img')).toHaveLength(2))

    await component.find('button[aria-label="Remove image-1.png"]').trigger('click')
    await vi.waitFor(() => expect(component.findAll('img')).toHaveLength(1))
    expect(component.find('button[aria-label="Open image-2.png"]').exists()).toBe(true)
  })
})
