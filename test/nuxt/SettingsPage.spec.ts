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

let setupStatus: any
registerEndpoint('/api/setup', () => setupStatus)

function agentStatus(id: string, login: string) {
  return { id, installed: true, installProblem: null, login, loginDetail: `${id} ${login}`, environments: login !== 'none', testModel: 'cheap', usage: null }
}

function settings() {
  return {
    defaultCwd: '/work',
    credentialSources: { geminiApiKey: null, openAiApiKey: 'server', anthropicApiKey: null, claudeCodeOauthToken: null, openCodeApiKey: null, kyutaiApiKey: null },
    defaultAgentModes: { 'claude-code': 'plan', codex: 'agent', opencode: 'build' },
    defaultAgentModels: { 'claude-code': '', codex: '', opencode: '' },
    defaultAgentConfig: { 'claude-code': {}, codex: {}, opencode: {} },
    vscodeSshHost: '', homeMounts: []
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
  setupStatus = {
    agents: [agentStatus('claude-code', 'none'), agentStatus('codex', 'subscription'), agentStatus('opencode', 'free')],
    voice: { transcriber: 'gemini', speaker: 'gemini', problem: null },
    progress: { finishedAt: null, skipped: [], checks: {} }
  }
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
      // "Default" is a named sentinel: Reka throws on `value: ''`.
      expect(button('Default')).toBeTruthy()
    })
    button('Default')!.click()
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

  it('tells a signed-out agent how to sign in, and saves only a typed token', async () => {
    const wrapper = await mountSuspended(AdapterSettingsPage, {
      route: '/settings/adapters/claude-code', attachTo: document.body
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Not signed in'))
    expect(document.body.textContent).toContain('claude setup-token')
    expect(document.body.textContent).not.toMatch(/\.env|NUXT_/)

    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="sk-ant-oat…"]')!
    input.value = ' sk-ant-oat-typed '
    input.dispatchEvent(new Event('input'))
    await vi.waitFor(() => expect(button('Save')).toBeTruthy())
    const saves = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(element => element.textContent?.trim() === 'Save')
    saves.at(-1)!.click()
    await vi.waitFor(() => expect(patched).toContainEqual({ claudeCodeOauthToken: 'sk-ant-oat-typed' }))
    wrapper.unmount()
  })

  it('says a key the server sets is set there, with nothing to change or remove', async () => {
    const wrapper = await mountSuspended(AdapterSettingsPage, {
      route: '/settings/adapters/codex', attachTo: document.body
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('OpenAI API key (optional fallback)'))
    expect(document.body.textContent).not.toContain('Sign in with your ChatGPT plan')
    // Open whenever a key is in force, so its billing warning is in view.
    await vi.waitFor(() => expect(document.body.textContent).toContain('Set by the server\'s configuration'))
    expect(document.body.textContent).toContain('Bills per token through the OpenAI API')
    expect(button('Remove')).toBeUndefined()
    wrapper.unmount()
  })
})
