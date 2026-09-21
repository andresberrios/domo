import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { computed, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SettingsPage from '~/pages/settings.vue'

/**
 * The settings page draws its permission-mode pickers from the adapters'
 * own probe, one per adapter, and saves a per-adapter default. Mounted here
 * as a page, with the one Electric-backed composable it uses stubbed out:
 * everything else it reads is a plain endpoint.
 */

mockNuxtImport('useMcpServers', () => () => ({
  servers: computed(() => []),
  isReady: ref(true)
}))

let stored: Record<string, unknown> = {}
const patched: any[] = []

registerEndpoint('/api/settings', () => stored)
registerEndpoint('/api/settings', {
  method: 'PATCH',
  handler: async (event) => {
    patched.push(await readBody(event))
    return stored
  }
})
registerEndpoint('/api/models', () => ({ models: [{ name: 'models/gemini-live', displayName: 'Gemini Live', live: true }] }))
registerEndpoint('/api/adapters/models', (event) => {
  const adapter = new URL(event.node.req.url ?? '/', 'http://x').searchParams.get('adapter')
  return adapter === 'codex'
    ? {
        models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
        current: 'gpt-5.5',
        modes: [
          { id: 'read-only', name: 'Read only', description: null },
          { id: 'agent', name: 'Agent', description: null }
        ],
        currentMode: 'agent'
      }
    : {
        models: [{ id: 'sonnet', name: 'Sonnet 5' }],
        current: 'sonnet',
        modes: [
          { id: 'default', name: 'Manual', description: null },
          { id: 'plan', name: 'Plan first', description: null }
        ],
        currentMode: 'default'
      }
})

function settings(overrides: Record<string, unknown> = {}) {
  return {
    liveModel: 'models/gemini-live',
    voiceName: 'Puck',
    systemInstruction: 'Be brief.',
    defaultCwd: '/work',
    proactiveNotifications: true,
    autoApprovePermissions: false,
    defaultAgentModes: { 'claude-code': 'plan', codex: 'agent' },
    language: 'en-US',
    autoTitle: true,
    vscodeSshHost: '',
    homeMounts: ['.ssh', '.gitconfig'],
    hasGeminiKey: true,
    hasAnthropicKey: false,
    hasOpenAiKey: false,
    ...overrides
  }
}

/** The select-menu trigger showing this label, as the user would find it. */
function trigger(label: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('button')]
    .find(element => element.textContent?.trim() === label)
}

async function mount() {
  return mountSuspended(SettingsPage, { attachTo: document.body })
}

beforeEach(() => {
  patched.length = 0
  stored = settings()
  document.body.innerHTML = ''
})

describe('settings page', () => {
  it('fills each adapter\'s mode picker from its own probe, showing the stored default by name', async () => {
    const wrapper = await mount()

    await vi.waitFor(() => {
      expect(trigger('Plan first'), 'the Claude Code picker shows the stored plan mode').toBeTruthy()
      expect(trigger('Agent'), 'the Codex picker shows the stored agent mode').toBeTruthy()
    })
    expect(document.body.textContent).not.toContain('Bypass permissions')
    wrapper.unmount()
  })

  it('keeps a stored mode the adapter no longer lists, rather than rendering a blank picker', async () => {
    stored = settings({ defaultAgentModes: { 'claude-code': 'bypassPermissions', codex: 'agent' } })
    const wrapper = await mount()

    await vi.waitFor(() => {
      expect(trigger('bypassPermissions')).toBeTruthy()
    })
    wrapper.unmount()
  })

  it('saves the per-adapter defaults and the mount list as an array', async () => {
    const wrapper = await mount()
    await vi.waitFor(() => expect(trigger('Plan first')).toBeTruthy())

    trigger('Save')!.click()

    await vi.waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0].defaultAgentModes).toEqual({ 'claude-code': 'plan', codex: 'agent' })
    expect(patched[0].homeMounts).toEqual(['.ssh', '.gitconfig'])
    wrapper.unmount()
  })
})
