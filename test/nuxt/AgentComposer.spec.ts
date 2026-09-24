import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp, UDropdownMenu, UPopover } from '#components'
import { getQuery, readBody } from 'h3'
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
    // The mock is what answers, so a test can make the adapter refuse by
    // having it throw — see the refusal case below.
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
  handler: (event) => {
    probed()
    // OpenCode answers provider-prefixed ids *and* provider-prefixed display
    // names; Claude Code answers bare ones. The composer has to read both.
    if (getQuery(event).adapter === 'opencode') {
      return {
        models: [
          { id: 'opencode-go/kimi-k3', name: 'opencode-go/Kimi K3' },
          { id: 'openai/gpt-5.4', name: 'openai/GPT-5.4' },
          { id: 'opencode/gpt-5.4', name: 'opencode/GPT-5.4' }
        ],
        current: 'opencode-go/kimi-k3'
      }
    }
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
    steering: null,
    lastError: null,
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    archived: false,
    usage: null,
    ...overrides
  }
}

/**
 * Open the settings panel.
 *
 * Reka opens a popover on a pointer sequence happy-dom does not synthesise
 * (see `UsageSidebarSummary.spec.ts`), so the popover's own `update:open`
 * drives this rather than a click on the card.
 */
async function openSettings(component: any) {
  await component.findComponent(UPopover).vm.$emit('update:open', true)
  await new Promise(resolve => setTimeout(resolve, 20))
}

/**
 * One column of the open panel, found by the header it is labelled by. The
 * panel shows every column at once — "High" is an effort on one adapter and
 * could be anything on the next — so nothing in here looks for an option
 * without saying which column it belongs to.
 *
 * The *last* match wins: the panel is teleported out of the app, and a mount
 * from an earlier test in this file may still have one in the document.
 */
function column(label: string): HTMLElement {
  const headings = Array.from(document.querySelectorAll('[id^="composer-"]'))
    .filter(node => node.textContent?.trim() === label)
  const heading = headings[headings.length - 1]
  const lists = heading
    ? Array.from(document.querySelectorAll(`[aria-labelledby="${heading.id}"]`))
    : []
  const list = lists[lists.length - 1]
  if (!list) {
    const seen = Array.from(document.querySelectorAll('[id^="composer-"]'))
      .map(node => node.textContent?.trim()).join(' | ')
    throw new Error(`No "${label}" column in the panel. Columns: ${seen}`)
  }
  return list as HTMLElement
}

/** An option of one column of the open panel. */
function option(columnLabel: string, text: string): HTMLElement {
  const options = Array.from(column(columnLabel).querySelectorAll('[role="option"]'))
  const found = options.find(node => node.textContent?.includes(text))
  if (!found) {
    throw new Error(
      `No option "${text}" in the "${columnLabel}" column. `
      + `Options: ${options.map(node => node.textContent?.trim()).join(' | ')}`
    )
  }
  return found as HTMLElement
}

/**
 * The Steer entry as the send button's dropdown was handed it. Its description
 * is what the whole steering-honesty change is about, and it is also what the
 * send button's own tooltip renders.
 */
function steerItem(component: any) {
  const items = component.findComponent(UDropdownMenu).props('items') as any[][]
  return items[0]!.find((item: any) => item.label === 'Steer')!
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

  /**
   * The delivery mode hangs off the send button rather than sitting in the
   * settings panel: it is a property of the message, not of the session. With
   * nothing running all three modes mean the same thing, so there is nothing
   * to choose and no control to choose it with.
   */
  it('offers the choice only while there is a turn to choose about', async () => {
    const idle = await mountSuspended(Harness, { props: { session: session('idle') } })
    expect(idle.find('button[aria-label^="Delivery:"]').exists()).toBe(false)

    const busy = await mountSuspended(Harness, { props: { session: session('thinking') } })
    expect(busy.find('button[aria-label="Delivery: Steer"]').exists()).toBe(true)
  })

  it('sends with the delivery mode chosen on the send button', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('thinking') } })

    // Reka does not open a menu on a click happy-dom can synthesise, so this
    // takes the items the dropdown was actually handed and invokes the one the
    // user would have clicked. What that covers is the wiring from the item to
    // the body the prompt endpoint receives; that Reka renders a menu is Reka's.
    const menu: any = component.findComponent(UDropdownMenu)
    const items = menu.props('items') as any[][]
    const queue = items[0]?.find(item => item.label === 'Queue')
    expect(queue.checked).toBe(false)
    queue.onUpdateChecked(true)

    await type(component, 'when you get a moment')

    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({
      content: [{ type: 'text', text: 'when you get a moment' }],
      delivery: 'queue'
    }))
  })

  /**
   * The OpenCode case. `steer` on an adapter that does not advertise the
   * extension falls back to `interrupt`, so the option that reads "put it into
   * the turn it is running now" cancels that turn instead — which is a
   * surprise rather than a choice unless it is said out loud. The row is what
   * is read: the picker is visible on a stopped session, so a probe here would
   * start an adapter.
   */
  it('says a steer will interrupt when the adapter cannot be steered', async () => {
    const component = await mountSuspended(Harness, {
      props: { session: session('thinking', { adapter: 'opencode', steering: false }) }
    })

    expect(component.find('textarea').attributes('placeholder'))
      .toContain('cannot be steered')

    // Read off the items the dropdown was handed, for the reason the test
    // above gives: Reka will not open a menu on a synthesised click.
    expect(steerItem(component).description).toContain('stops the current turn')
    // The option is still there and still the default: only the promise changed.
    expect(steerItem(component).checked).toBe(true)
    expect(sent).not.toHaveBeenCalled()
  })

  it('promises a real steer when the adapter advertised one', async () => {
    const component = await mountSuspended(Harness, {
      props: { session: session('thinking', { steering: true }) }
    })

    expect(component.find('textarea').attributes('placeholder'))
      .toContain('goes into the turn it is running')

    expect(steerItem(component).description).toBe('Put it into the turn it is running now')
  })

  /**
   * A session nothing has ever attached to reads `null`, which is not a
   * measurement: it must not be reported as an adapter that cannot be steered.
   */
  it('claims nothing about a session that has never run', async () => {
    const component = await mountSuspended(Harness, {
      props: { session: session('thinking', { steering: null }) }
    })

    expect(component.find('textarea').attributes('placeholder'))
      .not.toContain('cannot be steered')
    expect(steerItem(component).description).toBe('Put it into the turn it is running now')
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
 * The model, whatever the adapter itself offers, and the session mode are all
 * decisions about the message being written, so they live beside the box it is
 * written in rather than in the page header — as one card that opens a panel
 * of columns, because a Codex session has four of them at once and four
 * selects do not fit beside the attach button on a phone.
 */
describe('AgentComposer settings', () => {
  const claude = {
    modes: [
      { id: 'default', name: 'Manual', description: 'Ask before acting' },
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

  /**
   * The card is the whole surface until it is opened, so what it says is the
   * only thing a glance gets: the harness and the model on top, then every
   * setting the adapter offers and the mode — "Plan" and "Bypass permissions"
   * are the difference between a message being thought about and being acted
   * on.
   */
  it('summarises the model, the adapter’s own settings and the mode on the card', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })

    expect(component.text()).toContain('Claude Code · sonnet')
    expect(component.text()).toContain('Medium · Manual')
  })

  it('leaves out a setting the adapter does not offer', async () => {
    // A Claude model without effort levels publishes no effort option at all.
    const component = await mountSuspended(Harness, {
      props: { session: session('idle', { ...claude, configOptions: [] }) }
    })
    expect(component.text()).toContain('Claude Code · sonnet')
    expect(component.text()).not.toContain('Medium')
  })

  /**
   * Both adapters publish their fast-mode switch as a two-value select, and a
   * bare "Off" on the card says nothing while costing the width that pushes
   * the permission mode past the truncation.
   */
  it('names a toggle that is on and says nothing about one that is off', async () => {
    const fast = {
      id: 'fast_mode',
      name: 'Fast mode',
      description: null,
      category: null,
      currentValue: 'off',
      options: [{ value: 'on', name: 'On', description: null }, { value: 'off', name: 'Off', description: null }]
    }

    const off = await mountSuspended(Harness, {
      props: { session: session('idle', { ...claude, configOptions: [...claude.configOptions, fast] }) }
    })
    expect(off.text()).toContain('Medium · Manual')
    expect(off.text()).not.toContain('Off')

    const on = await mountSuspended(Harness, {
      props: {
        session: session('idle', {
          ...claude,
          configOptions: [...claude.configOptions, { ...fast, currentValue: 'on' }]
        })
      }
    })
    expect(on.text()).toContain('Medium · Fast mode · Manual')
  })

  it('opens a column per setting, each showing what is selected', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })
    await openSettings(component)

    expect(option('Effort', 'Medium').getAttribute('aria-selected')).toBe('true')
    expect(option('Effort', 'High').getAttribute('aria-selected')).toBe('false')
    expect(option('Permission mode', 'Manual').getAttribute('aria-selected')).toBe('true')
  })

  /**
   * The adapter is fixed when the session is created — there is no ACP call
   * that swaps one out from under a transcript — so it is named rather than
   * offered.
   */
  it('names the adapter without offering it as a choice', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })
    await openSettings(component)

    // The panel really is open — without this the two assertions below would
    // pass against an empty document.
    expect(column('Effort')).toBeTruthy()
    expect(() => column('Agent')).toThrow()
    expect(() => column('Adapter')).toThrow()
  })

  it('sends a reasoning-effort change by the adapter’s own id', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })
    await openSettings(component)

    option('Effort', 'High').click()

    await vi.waitFor(() => expect(patched).toHaveBeenCalledWith({ config: { effort: 'high' } }))
  })

  it('sends a mode change through the same endpoint', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })
    await openSettings(component)

    option('Permission mode', 'Plan').click()

    await vi.waitFor(() => expect(patched).toHaveBeenCalledWith({ modeId: 'plan' }))
  })

  it('sends a model change, and lists what the probe answered', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })
    await openSettings(component)

    await vi.waitFor(() => expect(option('Model', 'Opus')).toBeTruthy())
    option('Model', 'Opus').click()

    await vi.waitFor(() => expect(patched).toHaveBeenCalledWith({ model: 'opus' }))
  })

  /**
   * An authenticated OpenCode lists `openai/*` and `opencode/*` at once and 18
   * bare names are in both, so the provider prefix is what says which of two
   * billing relationships a message is about to spend. It may move off the
   * name's own line — the column is too narrow to truncate everything to
   * `opencode-go/Ki…` — but it may never be dropped.
   */
  it('keeps a model\u2019s provider visible in both the column and the card', async () => {
    const component = await mountSuspended(Harness, {
      props: {
        session: session('idle', {
          adapter: 'opencode',
          model: 'opencode-go/kimi-k3',
          modes: [{ id: 'build', name: 'Build', description: null }],
          modeId: 'build'
        })
      }
    })
    await openSettings(component)
    await vi.waitFor(() => expect(probed).toHaveBeenCalled())

    // The card carries the whole thing: one line, and the prefix is half of it.
    await vi.waitFor(() => expect(component.text()).toContain('OpenCode \u00b7 opencode-go/Kimi K3'))

    // The column splits it rather than truncating the name away.
    const chosen = await vi.waitFor(() => option('Model', 'Kimi K3'))
    expect(chosen.textContent).toContain('opencode-go')
    expect(chosen.getAttribute('aria-selected')).toBe('true')

    // Both `gpt-5.4`s are listed, told apart only by their provider, and
    // nothing collapses them into one.
    const models = Array.from(column('Model').querySelectorAll('[role="option"]'))
      .map(node => node.textContent?.replace(/\s+/g, ' ').trim())
    expect(models).toContain('GPT-5.4openai')
    expect(models).toContain('GPT-5.4opencode')
  })

  /**
   * The whole reason no column holds its own value: the adapter is the
   * authority, so a change it refuses has to leave the panel showing what the
   * session is really on. Nothing is written optimistically, so "revert" is
   * really "never moved" — and this is the test that says so, because the
   * difference is invisible until something refuses.
   */
  it('keeps the adapter\u2019s answer when a change is refused', async () => {
    patched.mockImplementationOnce(() => {
      throw createError({ statusCode: 400, statusMessage: 'Unsupported effort for this model' })
    })
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })
    await openSettings(component)

    option('Effort', 'High').click()

    // The failure is told, not swallowed.
    await vi.waitFor(() => expect(component.text()).toContain('Could not change the effort'))
    expect(component.text()).toContain('Unsupported effort for this model')

    // And the column still shows what the row says, not what was clicked.
    expect(option('Effort', 'Medium').getAttribute('aria-selected')).toBe('true')
    expect(option('Effort', 'High').getAttribute('aria-selected')).toBe('false')
    expect(component.text()).toContain('Medium \u00b7 Manual')
  })

  it('does not spawn a model probe until the panel is opened', async () => {
    const component = await mountSuspended(Harness, { props: { session: session('idle', claude) } })

    // Opening an agent page must not cost an adapter spawn.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(probed).not.toHaveBeenCalled()

    await openSettings(component)
    await vi.waitFor(() => expect(probed).toHaveBeenCalled())
  })
})
