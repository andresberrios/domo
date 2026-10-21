import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adapterEnv, adapterLaunch } from '../../server/lib/acp/adapter-process'
import { copilotMcpConfig, copilotModelOption, withCopilotModels } from '../../server/lib/acp/copilot'
import { modelConfigOption, currentModel, availableModelIds } from '../../server/lib/acp/model'
import { adapterConfigOptions } from '../../server/lib/acp/config-options'
import {
  COPILOT_AUTO_MODEL,
  fetchCopilotModels,
  normalizeCopilotUsage,
  pickerModels
} from '../../server/lib/copilot-credentials'
import { fetchCopilotUsage } from '../../server/lib/usage/copilot'
import { classifyCopilot } from '../../server/lib/setup'
import { forgetSecretSettings, rememberSecretSettings } from '../../server/lib/secret-settings'

const NO_SECRETS = { geminiApiKey: '', openAiApiKey: '', anthropicApiKey: '', claudeCodeOauthToken: '', openCodeApiKey: '', copilotGithubToken: '', xaiApiKey: '', kyutaiApiKey: '' }
const noGh = async () => null

/** Trimmed from a real `GET /copilot_internal/user` on a Copilot Free account. */
const FREE_ACCOUNT = {
  access_type_sku: 'free_limited_copilot',
  copilot_plan: 'individual',
  endpoints: { api: 'https://api.individual.githubcopilot.com' },
  quota_snapshots: {
    chat: { entitlement: 200, overage_permitted: false, percent_remaining: 99.9, quota_remaining: 199.8, remaining: 199, unlimited: false },
    completions: { entitlement: 2000, overage_permitted: false, percent_remaining: 100, quota_remaining: 2000, remaining: 2000, unlimited: false },
    premium_interactions: { entitlement: 0, overage_permitted: false, percent_remaining: 0, quota_remaining: 0, remaining: 0, unlimited: false }
  },
  quota_reset_date: '2026-11-01',
  quota_reset_date_utc: '2026-11-01T00:00:00.000Z'
}

/** The `/models` entries that matter, in the shape the API answers. */
const MODELS = {
  data: [
    { id: 'gpt-5-mini', name: 'GPT-5 mini', model_picker_enabled: true, policy: { state: 'enabled' }, capabilities: { type: 'chat' } },
    { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', model_picker_enabled: true, policy: { state: 'disabled' }, capabilities: { type: 'chat' } },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', model_picker_enabled: false, capabilities: { type: 'chat' } },
    { id: 'text-embedding-3-small', name: 'Embedding', model_picker_enabled: true, capabilities: { type: 'embeddings' } },
    { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', model_picker_enabled: true, capabilities: { type: 'chat' } }
  ]
}

describe('Copilot\'s models', () => {
  it('are what its picker offers and the policy allows, chat models only', () => {
    expect(pickerModels(MODELS)).toEqual([
      { id: 'gpt-5-mini', name: 'GPT-5 mini' },
      { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' }
    ])
  })

  it('are Auto alone with no token, on an error, and on a plan whose picker is empty', async () => {
    expect(await fetchCopilotModels(null, null)).toEqual([COPILOT_AUTO_MODEL])
    const failing = vi.fn(async () => new Response('nope', { status: 401 }))
    expect(await fetchCopilotModels('gho_x', null, failing as any)).toEqual([COPILOT_AUTO_MODEL])
    // Copilot Free: every model is listed and none is in the picker.
    // The fetch is a stub, so the account's own endpoint can be asked for here.
    vi.stubEnv('NUXT_COPILOT_API_BASE', '')
    const free = vi.fn(async () => Response.json({ data: MODELS.data.map(model => ({ ...model, model_picker_enabled: false })) }))
    expect(await fetchCopilotModels('gho_x', 'https://api.individual.githubcopilot.com', free as any)).toEqual([COPILOT_AUTO_MODEL])
    expect((free.mock.calls[0] as unknown[])[0]).toBe('https://api.individual.githubcopilot.com/models')
    vi.unstubAllEnvs()
  })
})

describe('Copilot\'s plan limits', () => {
  it('reads chat as a monthly bar, and leaves out completions and a quota the plan does not include', () => {
    expect(normalizeCopilotUsage(FREE_ACCOUNT)).toEqual([{
      limitId: 'chat',
      label: 'Chat (monthly)',
      usedPercent: expect.closeTo(0.1, 5),
      resetsAt: '2026-11-01T00:00:00.000Z',
      windowMinutes: 43200,
      status: 'allowed',
      amountUsed: 0.2,
      amountLimit: 200,
      currency: null,
      source: 'endpoint'
    }])
  })

  it('marks a spent quota refused unless overage is allowed', () => {
    const spent = (overage: boolean) => normalizeCopilotUsage({
      quota_snapshots: { premium_interactions: { entitlement: 300, percent_remaining: 0, quota_remaining: 0, overage_permitted: overage } }
    })[0]
    expect(spent(false)).toMatchObject({ limitId: 'premium_interactions', usedPercent: 100, status: 'rejected', amountUsed: 300 })
    expect(spent(true)).toMatchObject({ status: 'allowed' })
  })

  it('is unconfigured with no token or a refused one', async () => {
    await expect(fetchCopilotUsage(async () => null)).resolves.toMatchObject({ outcome: 'unconfigured' })
    const refused = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(fetchCopilotUsage(async () => 'gho_x', refused as any)).resolves.toMatchObject({ outcome: 'unconfigured' })
    const ok = vi.fn(async () => Response.json(FREE_ACCOUNT))
    await expect(fetchCopilotUsage(async () => 'gho_x', ok as any)).resolves.toMatchObject({ outcome: 'ok', limits: [{ limitId: 'chat' }] })
  })
})

/** What Copilot 1.0.98 answers `session/new` with: a mode and an Allow All select, and no model. */
const NEW_SESSION = {
  sessionId: 'cop_1',
  configOptions: [
    { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: 'agent', options: [{ value: 'agent', name: 'Agent' }] },
    { type: 'select', id: 'allow_all', name: 'Allow All', category: 'permissions', currentValue: 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }
  ]
}

function fakeConnection(answers: Record<string, any>) {
  const calls: Array<{ method: string, params: any }> = []
  const connection = {
    agent: {
      request: vi.fn(async (method: string, params: any) => {
        calls.push({ method, params })
        return answers[method] ?? {}
      })
    }
  }
  return { connection, calls }
}

describe('the model option Domo gives Copilot', () => {
  const models = async () => [COPILOT_AUTO_MODEL, { id: 'gpt-5-mini', name: 'GPT-5 mini' }]

  it('is added to session/new as a model select on Auto, and leaves the other options alone', async () => {
    const { connection } = fakeConnection({ 'session/new': NEW_SESSION })
    withCopilotModels(connection, models)
    const created = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })

    const option = modelConfigOption(created)
    expect(currentModel(option)).toMatchObject({ configId: 'model', value: 'auto' })
    expect(availableModelIds(option)).toEqual(['auto', 'gpt-5-mini'])
    expect(adapterConfigOptions(created).map(entry => entry.id)).toEqual(['allow_all'])
  })

  it('is set through session/set_model, and the answer says the session moved', async () => {
    const { connection, calls } = fakeConnection({ 'session/new': NEW_SESSION, 'session/set_config_option': { configOptions: NEW_SESSION.configOptions } })
    withCopilotModels(connection, models)
    await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })
    const answer = await connection.agent.request('session/set_config_option', { sessionId: 'cop_1', configId: 'model', value: 'gpt-5-mini' })

    expect(calls.at(-1)).toEqual({ method: 'session/set_model', params: { sessionId: 'cop_1', modelId: 'gpt-5-mini' } })
    expect(currentModel(modelConfigOption(answer))?.value).toBe('gpt-5-mini')
    expect(adapterConfigOptions(answer).map(entry => entry.id)).toEqual(['allow_all'])

    // And it stays moved when another option changes.
    const after = await connection.agent.request('session/set_config_option', { sessionId: 'cop_1', configId: 'allow_all', value: 'on' })
    expect(calls.at(-1)?.method).toBe('session/set_config_option')
    expect(currentModel(modelConfigOption(after))?.value).toBe('gpt-5-mini')
  })

  it('steps aside for a Copilot that publishes its own model option', async () => {
    const own = { ...NEW_SESSION, configOptions: [...NEW_SESSION.configOptions, copilotModelOption([{ id: 'x', name: 'X' }], 'x')] }
    const { connection, calls } = fakeConnection({ 'session/new': own, 'session/set_config_option': own })
    withCopilotModels(connection, models)
    const created = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })
    expect(availableModelIds(modelConfigOption(created))).toEqual(['x'])
    await connection.agent.request('session/set_config_option', { sessionId: 'cop_1', configId: 'model', value: 'x' })
    expect(calls.at(-1)?.method).toBe('session/set_config_option')
  })

  it('keeps a model the row names but the list does not, rather than losing it', () => {
    expect(copilotModelOption([COPILOT_AUTO_MODEL], 'gpt-5-mini').options.map((entry: any) => entry.value)).toEqual(['auto', 'gpt-5-mini'])
  })
})

describe('the stdio MCP servers Copilot gets at launch', () => {
  it('are written in its own config shape, every tool allowed', () => {
    expect(JSON.parse(copilotMcpConfig([{ name: 'browser', command: '/opt/node', args: ['cli.js'], env: [{ name: 'KEY', value: 'v' }] }]))).toEqual({
      mcpServers: { browser: { type: 'local', command: '/opt/node', args: ['cli.js'], env: { KEY: 'v' }, tools: ['*'] } }
    })
  })
})

describe('how Copilot is started and what it signs in with', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    for (const name of ['NUXT_COPILOT_GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'NUXT_GH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) Reflect.deleteProperty(process.env, name)
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://byok.example'
    process.env.COPILOT_PROVIDER_API_KEY = 'sk-byok'
  })
  afterEach(() => {
    process.env = { ...saved }
    forgetSecretSettings()
  })

  it('runs the platform executable in ACP mode, with updates off', () => {
    const launch = adapterLaunch('copilot')
    expect(launch.command).toMatch(/copilot-(linux|linuxmusl|darwin|win32)-[a-z0-9]+[/\\]copilot(\.exe)?$/)
    expect(launch.args).toEqual(['--acp', '--no-auto-update'])
  })

  it('on the host, passes no token unless one is saved, so its own login is used', async () => {
    process.env.GH_TOKEN = 'gho_host'
    const env = await adapterEnv('copilot', false, noGh)
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.COPILOT_AUTO_UPDATE).toBe('false')
  })

  it('passes the saved token, everywhere, and never a BYOK provider', async () => {
    rememberSecretSettings({ ...NO_SECRETS, copilotGithubToken: 'github_pat_stored' })
    for (const inContainer of [false, true]) {
      const env = await adapterEnv('copilot', inContainer, noGh)
      expect(env.COPILOT_GITHUB_TOKEN).toBe('github_pat_stored')
      expect(Object.keys(env).filter(name => name.startsWith('COPILOT_PROVIDER'))).toEqual([])
    }
  })

  it('in an environment with no saved token, signs in with the gh token it has for git', async () => {
    const env = await adapterEnv('copilot', true, async () => 'gho_from_gh')
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBe('gho_from_gh')
  })
})

describe('what Copilot signs in with, as the setup guide says it', () => {
  it('puts the saved token first, then this computer\'s login', () => {
    expect(classifyCopilot({ token: true, hostLogin: false, ghToken: null })).toMatchObject({ login: 'subscription', environments: true })
    expect(classifyCopilot({ token: false, hostLogin: true, ghToken: 'gho_x' })).toMatchObject({ login: 'subscription', environments: true })
    // Copilot refuses a classic token, so an environment holding one cannot sign in.
    expect(classifyCopilot({ token: false, hostLogin: true, ghToken: 'ghp_classic' })).toMatchObject({ login: 'subscription', environments: false })
    expect(classifyCopilot({ token: false, hostLogin: false, ghToken: 'gho_x' })).toMatchObject({ login: 'none' })
  })
})
