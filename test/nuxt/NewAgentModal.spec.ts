import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { describe, expect, it, vi } from 'vitest'

import NewAgentModal from '~/components/NewAgentModal.vue'

/**
 * Reka's select items throw on an empty-string value, so "no environment" cannot
 * be `''`. The error only appears when the menu is opened and its items render,
 * which is why nothing but a mounted, opened dialog can catch it.
 */
registerEndpoint('/api/settings', () => ({ defaultCwd: '/work' }))

describe('NewAgentModal', () => {
  it('opens the development environment menu without throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wrapper = await mountSuspended(NewAgentModal, {
      props: { open: true },
      attachTo: document.body
    })

    const trigger = [...document.body.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"]')]
      .find(element => element.textContent?.includes('Local host directory'))
    expect(trigger, 'the environment select renders with its default selected').toBeTruthy()

    trigger!.click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain('Local host directory')
    })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    wrapper.unmount()
  })
})
