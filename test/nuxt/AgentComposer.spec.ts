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
/** Every picker in the composer goes through the one consolidated PATCH. */
const patched = vi.fn()

registerEndpoint('/api/agents/ag_1', {
  method: 'PATCH',
  handler: async (event) => {
    patched(await readBody(event))
    return { id: 'ag_1' }
  }
})

/**
 * The model list is the one thing not already on the session row, so the
 * composer asks the server, which spawns a probe for it.
 */
const probed = vi.fn()

registerEndpoint('/api/adapters/models', {
  method: 'GET',
  handler: () => {
    probed()
    return { models: [{ id: 'sonnet', name: 'Sonnet' }, { id: 'opus', name: 'Opus' }], current: 'sonnet' }
  }
})

const Harness = defineComponent({
  props: { session: { type: Object as () => AgentSession, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(AgentComposer, { session: props.session })
  })
})

function session(
  status: AgentSession['status'],
  overrides: Partial<AgentSession> = {}
): AgentSession {
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
    config: null,
    configOptions: null,
    lastError: null,
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    archived: false,
    retiredAt: null,
    retiredReason: null,
    usage: null,
    ...overrides
  }
}

/**
 * Open one of the footer's pickers by the value it is showing.
 *
 * `USelectMenu` is a Reka *Combobox* and opens on `click` — unlike
 * `UDropdownMenu`, which needs a raw `pointerdown` (see `ProjectTree.spec.ts`).
 * Measured: a pointerdown on this trigger leaves zero `[role=option]` nodes in
 * the document, a click leaves all of them.
 */
async function openMenu(component: any, label: string) {
  const trigger = component.findAll('button').find((button: any) => button.text().includes(label))
  if (!trigger) {
    const seen = component.findAll('button').map((b: any) => b.text()).join(' | ')
    throw new Error(`No picker showing "${label}". Buttons: ${seen}`)
  }
  await trigger.trigger('click')
  await new Promise(resolve => setTimeout(resolve, 20))
  return trigger
}

/** The options of whichever menu is open; they are teleported out of the app. */
function option(text: string): HTMLElement {
  const found = Array.from(document.querySelectorAll('[role="option"]'))
    .find(node => node.textContent?.includes(text))
  if (!found) {
    const seen = Array.from(document.querySelectorAll('[role="option"]')).map(n => n.textContent).join(' | ')
    throw new Error(`No option "${text}" in the open menu. Options: ${seen}`)
  }
  return found as HTMLElement
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
  patched.mockClear()
  probed.mockClear()
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

  /**
   * While the agent works the submit control is a stop button, so without a
   * send button of its own a touch user has no way to steer a running turn:
   * Enter types a line break by design and there is nothing else to press.
   */
  it('offers a send button beside stop while the agent is working', async () => {
    restorePointer = pointer('coarse')
    const component = await mountSuspended(Harness, { props: { session: session('thinking') } })

    const send = component.find('button[aria-label="Send"]')
    expect(send.exists()).toBe(true)
    expect(send.attributes('disabled')).toBeDefined()

    await type(component, 'actually, use the other endpoint')
    expect(sent).not.toHaveBeenCalled()

    await component.find('button[aria-label="Send"]').trigger('click')

    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'actually, use the other endpoint' }],
      delivery: 'steer'
    }))
  })

  it('has no send button while the agent is idle, where submit already is one', async () => {
    restorePointer = pointer('coarse')
    const component = await mountSuspended(Harness, { props: { session: session('idle') } })

    expect(component.find('button[aria-label="Send"]').exists()).toBe(false)
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

/**
 * The mode, the model and whatever the adapter itself offers are all decisions
 * about the message being written, so they live beside the box it is written
 * in rather than in the page header.
 */
describe('AgentComposer settings', () => {
  const claude = {
    modes: [
      { id: 'default', name: 'Manual', description: null },
      { id: 'plan', name: 'Plan', description: null }
    ],
    modeId: 'default',
    model: 'sonnet',
    // What claude-agent-acp really publishes: id `effort`, category
    // `thought_level`. Codex calls the same thing `reasoning_effort`, which is
    // why the composer renders the list instead of naming either.
    configOptions: [{
      id: 'effort',
      name: 'Effort',
      description: 'Available effort levels for this model',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low', description: null },
        { value: 'medium', name: 'Medium', description: null },
        { value: 'high', name: 'High', description: null }
      ]
    }]
  } satisfies Partial<AgentSession>

  it('shows the mode, the model and the adapter’s own settings', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })

    expect(component.text()).toContain('Manual')
    expect(component.text()).toContain('sonnet')
    expect(component.text()).toContain('Medium')
  })

  it('draws nothing for an adapter that offers no settings of its own', async () => {
    // A Claude model without effort levels publishes no effort option at all.
    const component = await mountSuspended(Harness, {
      props: { session: session('idle', { ...claude, configOptions: [] }) }
    })
    expect(component.text()).not.toContain('Medium')
  })

  it('sends a reasoning-effort change by the adapter’s own id', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })

    await openMenu(component, 'Medium')
    option('High').click()

    await vi.waitFor(() => expect(patched).toHaveBeenCalledWith({ config: { effort: 'high' } }))
  })

  it('sends a mode change through the same endpoint', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })

    await openMenu(component, 'Manual')
    option('Plan').click()

    await vi.waitFor(() => expect(patched).toHaveBeenCalledWith({ modeId: 'plan' }))
  })

  it('does not spawn a model probe until the model menu is opened', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })

    // Opening an agent page must not cost an adapter spawn.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(probed).not.toHaveBeenCalled()

    await openMenu(component, 'sonnet')
    await vi.waitFor(() => expect(probed).toHaveBeenCalled())
  })
})
