import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { readBody } from 'h3'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AgentComposer from '~/components/AgentComposer.vue'
import type { AgentSession } from '~~/shared/types'

/**
 * The composer is where a person decides what happens to a message sent at an
 * agent that is already working, so the mode has to leave the browser with it.
 */
const sent = vi.fn()

registerEndpoint('/api/agents/ag_1/prompt', {
  method: 'POST',
  handler: async (event) => {
    sent(await readBody(event))
    return { delivery: 'steer', outcome: 'steered' }
  }
})

/** What the upload endpoint answered with, so a test can decide per case. */
const uploaded = vi.fn(() => ({
  files: [{ name: 'shot.png', path: '/data/uploads/up_1.png', mimeType: 'image/png', size: 12 }]
}))

registerEndpoint('/api/uploads', { method: 'POST', handler: () => uploaded() })

/**
 * happy-dom has no `ClipboardEvent` worth using, and the component only ever
 * asks the event for its `clipboardData`.
 */
function paste(component: any, files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { files, getData: (format: string) => (format === 'text/plain' ? text : '') }
  })
  component.find('textarea').element.dispatchEvent(event)
  return event
}

function image(name = ''): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

const Harness = defineComponent({
  props: { session: { type: Object as () => AgentSession, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(AgentComposer, { session: props.session })
  })
})

function session(status: AgentSession['status']): AgentSession {
  return {
    id: 'ag_1',
    voiceSessionId: null,
    adapter: 'claude-code',
    acpSessionId: 'acp_1',
    title: 'Auth refactor',
    cwd: '/workspaces/domo',
    devEnvironmentId: null,
    status,
    modeId: null,
    modes: null,
    model: null,
    lastError: null,
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    archived: false,
    usage: null
  }
}

async function type(component: any, text: string) {
  const input = component.find('textarea')
  await input.setValue(text)
  await input.trigger('keydown', { key: 'Enter' })
}

/**
 * `matchMedia` is what decides whether Enter sends. happy-dom has one, so the
 * pointer is faked by answering the one query the composer asks.
 */
function pointer(kind: 'coarse' | 'fine') {
  const real = window.matchMedia
  window.matchMedia = ((query: string) => ({
    matches: query === `(pointer: ${kind})`,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {}
  })) as unknown as typeof window.matchMedia
  return () => { window.matchMedia = real }
}

let restorePointer: (() => void) | null = null

beforeEach(() => {
  sent.mockClear()
  uploaded.mockClear()
})
afterEach(() => {
  restorePointer?.()
  restorePointer = null
})

describe('AgentComposer', () => {
  it('sends with a delivery mode, and steers by default', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('thinking') } })

    await type(component, 'do the tests first')

    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'do the tests first' }],
      delivery: 'steer'
    }))
  })

  it('offers the choice only while there is a turn to choose about', async () => {
    const idle = await mountSuspended(Harness, { props: { session: session('idle') } })
    expect(idle.text()).not.toContain('Steer')

    const busy = await mountSuspended(Harness, { props: { session: session('thinking') } })
    expect(busy.text()).toContain('Steer')
  })
})

describe('AgentComposer on a touch screen', () => {
  it('lets Enter make a line break instead of sending', async () => {
    restorePointer = pointer('coarse')
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    await type(component, 'first line')

    // The keyboard's return key is the only line break a phone has; the send
    // button is how a message leaves.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(sent).not.toHaveBeenCalled()
  })

  it('still sends on Enter with a fine pointer', async () => {
    restorePointer = pointer('fine')
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    await type(component, 'ship it')

    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'ship it' }],
      delivery: 'steer'
    }))
  })
})

describe('AgentComposer pasting', () => {
  it('attaches a pasted image and sends it with the message', async () => {
    restorePointer = pointer('fine')
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    paste(component, [image()])
    await vi.waitFor(() => expect(component.text()).toContain('shot.png'))

    await type(component, 'what is wrong here?')

    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({
      content: [
        {
          type: 'resource_link',
          uri: 'file:///data/uploads/up_1.png',
          name: 'shot.png',
          mimeType: 'image/png',
          size: 12
        },
        { type: 'text', text: 'what is wrong here?' }
      ],
      delivery: 'steer'
    }))
  })

  it('sends an attachment with no message at all', async () => {
    // `UChatPrompt` will not emit `submit` for an empty textarea, and a pasted
    // screenshot on its own is the ordinary thing to send.
    restorePointer = pointer('fine')
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    paste(component, [image()])
    await vi.waitFor(() => expect(component.text()).toContain('shot.png'))

    await component.find('textarea').trigger('keydown', { key: 'Enter' })

    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({
      content: [{
        type: 'resource_link',
        uri: 'file:///data/uploads/up_1.png',
        name: 'shot.png',
        mimeType: 'image/png',
        size: 12
      }],
      delivery: 'steer'
    }))
  })

  it('leaves an ordinary text paste to the textarea', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    const event = paste(component, [], 'just some words')

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(uploaded).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not hijack a paste that carries text beside its picture', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    const event = paste(component, [image()], 'one\ttwo')

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(uploaded).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('says so when an upload fails and keeps nothing', async () => {
    uploaded.mockImplementationOnce(() => {
      throw createError({ statusCode: 500, statusMessage: 'Disk full' })
    })
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    paste(component, [image()])

    await vi.waitFor(() => expect(component.text()).toContain('Upload failed'))
    expect(component.text()).not.toContain('shot.png')
  })
})
