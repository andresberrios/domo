import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { createError, readBody } from 'h3'
import { describe, expect, it, vi } from 'vitest'

import NewAgentModal from '~/components/NewAgentModal.vue'

/**
 * Reka's select items throw on an empty-string value, so neither "no
 * environment" nor "adapter default" can be `''`. The error only appears when
 * the menu is opened and its items render, which is why nothing but a mounted,
 * opened dialog can catch it.
 */
registerEndpoint('/api/settings', () => ({ defaultCwd: '/work' }))

const posted: any[] = []
registerEndpoint('/api/agents', {
  method: 'POST',
  handler: async (event) => {
    posted.push(await readBody(event))
    return { id: 'ag_new' }
  }
})

let modelsFail = false
registerEndpoint('/api/adapters/models', () => {
  if (modelsFail) throw createError({ statusCode: 502, statusMessage: 'Not logged in' })
  return {
    models: [{ id: 'sonnet', name: 'Sonnet 5' }, { id: 'haiku', name: 'Haiku 4.5' }],
    current: 'sonnet'
  }
})

async function open() {
  const wrapper = await mountSuspended(NewAgentModal, {
    props: { open: true },
    attachTo: document.body
  })
  return wrapper
}

/** The select whose current label matches, as the user would find it. */
function selectTrigger(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]')]
    .find(element => element.textContent?.includes(label))
}

describe('NewAgentModal', () => {
  it('opens the development environment menu without throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    const trigger = selectTrigger('Local host directory')
    expect(trigger, 'the environment select renders with its default selected').toBeTruthy()

    trigger!.click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain('Local host directory')
    })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    wrapper.unmount()
  })

  it('offers the adapter\'s own models, behind an "adapter default" that is not an empty value', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    const trigger = await vi.waitFor(() => {
      const found = selectTrigger('Adapter default')
      expect(found).toBeTruthy()
      return found!
    })

    trigger.click()
    await vi.waitFor(() => {
      const listbox = [...document.body.querySelectorAll('[role="listbox"]')]
        .find(element => element.textContent?.includes('Adapter default'))
      // The list the server probed the adapter for, not a hard-coded one.
      expect(listbox?.textContent).toContain('Haiku 4.5')
    })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    wrapper.unmount()
  })

  it('submits no model while the default is selected', async () => {
    posted.length = 0
    const wrapper = await open()

    // Queried off `document.body`, not the wrapper: `UModal` teleports its
    // content, so `wrapper.find` sees none of the form. The event has to bubble
    // or Nuxt UI's input never re-emits and the submit button stays disabled.
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="auth refactor"]')!
    input.value = 'auth refactor'
    input.dispatchEvent(new Event('input', { bubbles: true }))

    const start = await vi.waitFor(() => {
      const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find(element => element.textContent?.includes('Start agent'))
      expect(button?.disabled).toBe(false)
      return button!
    })
    start.click()

    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].model).toBeUndefined()
    expect(posted[0]).toMatchObject({ title: 'auth refactor', adapter: 'claude-code' })
    wrapper.unmount()
  })

  it('says so inline when the adapter cannot be asked, and still lets the default through', async () => {
    modelsFail = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await open()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Could not ask Claude Code which models it offers')
    })
    // A failed probe must not take the whole form down with it.
    expect(selectTrigger('Adapter default')).toBeTruthy()

    errors.mockRestore()
    modelsFail = false
    wrapper.unmount()
  })
})
