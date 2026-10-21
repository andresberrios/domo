import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SetupPage from '~/pages/setup.vue'

let status: any
const patches: any[] = []
const checks: any[] = []

registerEndpoint('/api/setup', () => status)
registerEndpoint('/api/setup', {
  method: 'PATCH',
  handler: async (event) => {
    const body = await readBody(event)
    patches.push(body)
    if (body.skip) status.progress.skipped.push(body.skip)
    if (body.finished) status.progress.finishedAt = '2026-10-15T00:00:00.000Z'
    return status.progress
  }
})
registerEndpoint('/api/setup/check', {
  method: 'POST',
  handler: async (event) => {
    const { target } = await readBody(event)
    checks.push(target)
    const result = { ok: false, at: '2026-10-15T00:00:00.000Z', summary: 'Codex could not sign in: 401. Run codex login again on the computer Domo runs on.' }
    status.progress.checks[target] = result
    return { ...result, reply: null, progress: status.progress }
  }
})
registerEndpoint('/api/settings', () => ({
  agentVoice: { transcriber: 'gemini', speaker: 'gemini' },
  credentialSources: { geminiApiKey: null, openAiApiKey: null, anthropicApiKey: null, claudeCodeOauthToken: null, openCodeApiKey: null, copilotGithubToken: null, xaiApiKey: null, kyutaiApiKey: null },
  hasOpenCodeAuth: false
}))

function agent(id: string, login: string) {
  return { id, installed: true, installProblem: null, login, loginDetail: `${id} detail`, environments: true, testModel: 'cheap', usage: null }
}

function button(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === label)
}

beforeEach(() => {
  patches.length = 0
  checks.length = 0
  document.body.innerHTML = ''
  status = {
    agents: [agent('claude-code', 'none'), agent('codex', 'api-key'), agent('opencode', 'free'), agent('copilot', 'subscription'), agent('grok', 'subscription')],
    voice: { transcriber: 'gemini', speaker: 'gemini', problem: 'No Gemini API key. Add one in Settings → Voice.' },
    progress: { finishedAt: null, skipped: [], checks: {} }
  }
})

describe('setup guide', () => {
  it('opens what needs doing, warns before a check bills a key, and shows its result', async () => {
    const wrapper = await mountSuspended(SetupPage, { route: '/setup', attachTo: document.body })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Not signed in'))
    expect(document.body.textContent).toContain('claude setup-token')
    expect(document.body.textContent).toContain('On an API key that bills a fraction of a cent')
    expect(document.body.textContent).toContain('Use the free open models instead')
    // Nothing to test until it can sign in.
    expect(button('Test Claude Code')).toBeUndefined()

    button('Test Codex')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Run codex login again'))
    expect(checks).toEqual(['codex'])
    wrapper.unmount()
  })

  // An earlier check that finished later is what the guide keeps; the reply
  // of the check this page ran belongs to a result no longer shown.
  it('shows what the agent said only beside the result it came with', async () => {
    registerEndpoint('/api/setup/check', {
      method: 'POST',
      handler: async () => {
        const answered = { ok: true, at: '2026-10-15T10:00:30.000Z', summary: 'gpt-5.6-luna answered in 2.0 s.' }
        status.progress.checks.codex = { ok: false, at: '2026-10-15T10:00:40.000Z', summary: 'Codex did not answer within 90 seconds.' }
        return { ...answered, reply: 'ready', progress: status.progress }
      }
    })
    const wrapper = await mountSuspended(SetupPage, { route: '/setup', attachTo: document.body })
    await vi.waitFor(() => expect(button('Test Codex')).toBeTruthy())
    button('Test Codex')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('did not answer within 90 seconds'))
    expect(document.body.textContent).not.toContain('It said')
    wrapper.unmount()
  })

  it('remembers a skipped step and finishing', async () => {
    const wrapper = await mountSuspended(SetupPage, { route: '/setup', attachTo: document.body })
    await vi.waitFor(() => expect(button('I don\'t use OpenCode')).toBeTruthy())
    button('I don\'t use OpenCode')!.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('Skipped'))

    button('Finish')!.click()
    await vi.waitFor(() => expect(patches).toEqual([{ skip: 'opencode' }, { finished: true }]))
    wrapper.unmount()
  })
})
