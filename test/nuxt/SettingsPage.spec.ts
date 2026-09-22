import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AdapterSettingsPage from '~/pages/settings/adapters/[adapter].vue'
import SettingsShell from '~/components/SettingsShell.vue'

let stored: any
const patched: any[] = []

registerEndpoint('/api/settings', () => stored)
registerEndpoint('/api/settings', {
  method: 'PATCH',
  handler: async (event) => {
    patched.push(await readBody(event))
    return stored
  }
})
registerEndpoint('/api/adapters/models', (event) => {
  const adapter = new URL(event.node.req.url ?? '/', 'http://x').searchParams.get('adapter')
  if (adapter === 'opencode') {
    return {
      models: [{ id: 'opencode-go/kimi-k3', name: 'Kimi K3' }],
      current: 'opencode-go/kimi-k3',
      modes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }],
      currentMode: 'build',
      configOptions: [{
        id: 'effort', name: 'Effort', category: 'thought_level', currentValue: 'medium',
        options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }]
      }]
    }
  }
  return {
    models: [{ id: 'sonnet', name: 'Sonnet' }], current: 'sonnet',
    modes: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan first' }],
    currentMode: 'default', configOptions: []
  }
})

function settings() {
  return {
    liveModel: 'gemini-live', voiceName: 'Puck', systemInstruction: '', defaultCwd: '/work',
    proactiveNotifications: true, autoApprovePermissions: false,
    defaultAgentModes: { 'claude-code': 'plan', codex: 'agent', opencode: 'build' },
    defaultAgentModels: { 'claude-code': '', codex: '', opencode: '' },
    defaultAgentConfig: { 'claude-code': {}, codex: {}, opencode: {} },
    language: 'en-US', autoTitle: true, vscodeSshHost: '', homeMounts: []
  }
}

function option(label: string) {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
    .find(element => element.textContent?.trim() === label)
}

function button(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.textContent?.trim() === label)
}

beforeEach(() => {
  stored = settings()
  patched.length = 0
  document.body.innerHTML = ''
})

describe('adapter settings page', () => {
  it('renders a settings sidebar with one nested link per adapter', async () => {
    const wrapper = await mountSuspended(SettingsShell, {
      route: '/settings/adapters/opencode',
      props: { title: 'OpenCode' },
      attachTo: document.body
    })
    const links = [...document.body.querySelectorAll<HTMLAnchorElement>('nav a')]
      .map(link => ({ text: link.textContent?.trim(), href: link.getAttribute('href') }))

    expect(links).toEqual(expect.arrayContaining([
      { text: 'General', href: '/settings' },
      { text: 'Coding agents', href: '/settings/agents' },
      { text: 'Claude Code', href: '/settings/adapters/claude-code' },
      { text: 'Codex', href: '/settings/adapters/codex' },
      { text: 'OpenCode', href: '/settings/adapters/opencode' },
      { text: 'Development environments', href: '/settings/environments' },
      { text: 'MCP servers', href: '/settings/mcp' }
    ]))
    wrapper.unmount()
  })

  it('gives OpenCode its own page and calls its ACP modes agents', async () => {
    const wrapper = await mountSuspended(AdapterSettingsPage, {
      route: '/settings/adapters/opencode', attachTo: document.body
    })
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('OpenCode')
      expect(document.body.textContent).toContain('Default agent')
      expect(button('Build')).toBeTruthy()
      expect(document.body.textContent).not.toContain('Check OpenCode Go limits')
    })
    wrapper.unmount()
  })

  it('offers the models the adapter reported, plus leaving it to the adapter', async () => {
    // The ids are the adapter's own and are not guessable, so the picker is fed
    // from the same probe this page already makes rather than typed.
    const wrapper = await mountSuspended(AdapterSettingsPage, {
      route: '/settings/adapters/claude-code', attachTo: document.body
    })

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Default model')
      // "Adapter default" is a named sentinel: Reka throws on `value: ''`.
      expect(button('Adapter default')).toBeTruthy()
    })
    button('Adapter default')!.click()
    await vi.waitFor(() => expect(option('Sonnet')).toBeTruthy())
    option('Sonnet')!.click()
    button('Save')!.click()

    await vi.waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0].defaultAgentModels)
      .toEqual({ 'claude-code': 'sonnet', codex: '', opencode: '' })
    wrapper.unmount()
  })

  it('saves this adapter while preserving the other adapter defaults', async () => {
    const wrapper = await mountSuspended(AdapterSettingsPage, {
      route: '/settings/adapters/claude-code', attachTo: document.body
    })
    await vi.waitFor(() => expect(button('Plan first')).toBeTruthy())
    button('Save')!.click()
    await vi.waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0].defaultAgentModes).toEqual({ 'claude-code': 'plan', codex: 'agent', opencode: 'build' })
    wrapper.unmount()
  })
})
