import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adapterEnv, adapterLaunch, GROK_ARGS, grokBinary } from '../../server/lib/acp/adapter-process'
import { GROK_MODES, withGrok } from '../../server/lib/acp/grok'
import { grokTokenCommand, providerAnswer, tokenExpiry } from '../../server/lib/acp/grok-token'
import { availableModes, currentModeId } from '../../server/lib/acp/mode'
import { classifyGrok } from '../../server/lib/setup'
import { forgetSecretSettings, rememberSecretSettings } from '../../server/lib/secret-settings'

const NO_SECRETS = { geminiApiKey: '', openAiApiKey: '', anthropicApiKey: '', claudeCodeOauthToken: '', openCodeApiKey: '', copilotGithubToken: '', xaiApiKey: '', kyutaiApiKey: '' }
const noGh = async () => null
const noOpenCode = async () => ({ apiKey: null, permission: { host: 'ask', environment: 'allow' } as const })
const loggedIn = async () => true
const loggedOut = async () => false

function fakeConnection(answers: Record<string, any>) {
  const calls: Array<{ method: string, params: any }> = []
  const notes: Array<{ method: string, params: any }> = []
  const connection = {
    agent: {
      request: vi.fn(async (method: string, params: any) => {
        calls.push({ method, params })
        return answers[method] ?? {}
      }),
      notify: vi.fn(async (method: string, params: any) => {
        notes.push({ method, params })
      })
    }
  }
  return { connection, calls, notes }
}

describe('how Grok is started and what it signs in with', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    for (const name of ['NUXT_XAI_API_KEY', 'XAI_API_KEY', 'GROK_HOME', 'NUXT_GROK_ACP_ENTRY']) Reflect.deleteProperty(process.env, name)
  })
  afterEach(() => {
    process.env = { ...saved }
    forgetSecretSettings()
  })

  // Where the executable comes from is `grokBinary`'s, below: resolving the
  // real package here would unpack 160 MB into node_modules.
  it('runs the executable as a private ACP server, never the shared leader', () => {
    process.env.NUXT_GROK_ACP_ENTRY = '/opt/grok/bin/grok'
    expect(adapterLaunch('grok')).toEqual({ command: '/opt/grok/bin/grok', args: ['agent', '--no-leader', 'stdio'] })
    expect(GROK_ARGS).toEqual(['agent', '--no-leader', 'stdio'])
  })

  // The probes run in throwaway directories, which must never be trusted.
  it('trusts the working directory for a session, and only for a session, ahead of `agent`', () => {
    process.env.NUXT_GROK_ACP_ENTRY = '/opt/grok/bin/grok'
    expect(adapterLaunch('grok', { session: true }).args).toEqual(['--trust', 'agent', '--no-leader', 'stdio'])
    expect(adapterLaunch('grok').args).not.toContain('--trust')
  })

  it('on the host, leaves the key out while there is a grok login, so the plan is what bills', async () => {
    rememberSecretSettings({ ...NO_SECRETS, xaiApiKey: 'xai-stored' })
    const env = await adapterEnv('grok', false, noGh, noOpenCode, loggedIn)
    expect(env.XAI_API_KEY).toBeUndefined()
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1')
  })

  // Asking starts Grok: a host session with no key has nothing to decide.
  it('on the host with no key, does not ask whether there is a login', async () => {
    const asked = vi.fn(loggedIn)
    await adapterEnv('grok', false, noGh, noOpenCode, asked)
    expect(asked).not.toHaveBeenCalled()
  })

  it('on the host with no login, signs in with the saved key', async () => {
    rememberSecretSettings({ ...NO_SECRETS, xaiApiKey: 'xai-stored' })
    const env = await adapterEnv('grok', false, noGh, noOpenCode, loggedOut)
    expect(env.XAI_API_KEY).toBe('xai-stored')
  })

  // The login's refresh token is single-use: an environment borrows access
  // tokens from this computer's Grok through Domo, and never holds the login.
  it('in an environment, signs in through this computer\'s login, never with the key while there is one', async () => {
    rememberSecretSettings({ ...NO_SECRETS, xaiApiKey: 'xai-stored' })
    const env = await adapterEnv('grok', true, noGh, noOpenCode, loggedIn)
    expect(env.XAI_API_KEY).toBeUndefined()
    expect(env.GROK_AUTH_PROVIDER_COMMAND).toBe(grokTokenCommand())
    expect(env.DOMO_GROK_TOKEN_URL).toMatch(/\/api\/internal\/grok-token$/)
    expect(Object.values(env).join('\n')).not.toMatch(/refresh/i)
  })

  it('in an environment with no login here, has the key or nothing', async () => {
    expect(await adapterEnv('grok', true, noGh, noOpenCode, loggedOut)).not.toHaveProperty('XAI_API_KEY')
    rememberSecretSettings({ ...NO_SECRETS, xaiApiKey: 'xai-stored' })
    const env = await adapterEnv('grok', true, noGh, noOpenCode, loggedOut)
    expect(env.XAI_API_KEY).toBe('xai-stored')
    expect(env.GROK_AUTH_PROVIDER_COMMAND).toBeUndefined()
  })

  it('never passes a key from the shell it was started in, only one Domo names', async () => {
    process.env.GROK_CODE_XAI_API_KEY = 'xai-legacy'
    const env = await adapterEnv('grok', true, noGh, noOpenCode, loggedOut)
    expect(env.GROK_CODE_XAI_API_KEY).toBeUndefined()
    expect(env.XAI_API_KEY).toBeUndefined()
  })

  it('keeps a GROK_HOME on the host, where the login lives, and not in a container', async () => {
    process.env.GROK_HOME = '/Users/me/.grok-work'
    expect((await adapterEnv('grok', false, noGh, noOpenCode, loggedIn)).GROK_HOME).toBe('/Users/me/.grok-work')
    expect((await adapterEnv('grok', true, noGh, noOpenCode, loggedIn)).GROK_HOME).toBeUndefined()
  })
})

describe('the Grok executable', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'domo-grok-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function install(): Promise<{ pkgPath: string, bin: string }> {
    const modules = join(root, 'node_modules', '@xai-official')
    const platformDir = join(modules, `grok-${process.platform}-${process.arch}`)
    await mkdir(join(modules, 'grok'), { recursive: true })
    await mkdir(join(platformDir, 'bin'), { recursive: true })
    await writeFile(join(modules, 'grok', 'package.json'), '{"name":"@xai-official/grok"}')
    await writeFile(join(platformDir, 'package.json'), `{"name":"@xai-official/grok-${process.platform}-${process.arch}"}`)
    const exe = process.platform === 'win32' ? 'grok.exe' : 'grok'
    await writeFile(join(platformDir, 'bin', `${exe}.br`), brotliCompressSync(Buffer.from('#!/bin/sh\necho grok\n')))
    return { pkgPath: join(modules, 'grok', 'package.json'), bin: join(platformDir, 'bin', exe) }
  }

  it('is unpacked once beside the compressed one, executable, and reused after', async () => {
    const { pkgPath, bin } = await install()
    expect(grokBinary(pkgPath)).toBe(bin)
    expect(await readFile(bin, 'utf8')).toBe('#!/bin/sh\necho grok\n')
    if (process.platform !== 'win32') expect((await stat(bin)).mode & 0o111).not.toBe(0)

    await writeFile(bin, 'already here')
    expect(grokBinary(pkgPath)).toBe(bin)
    expect(await readFile(bin, 'utf8')).toBe('already here')
  })
})

describe('the Grok connection', () => {
  const NEW_SESSION = { sessionId: 'grk_1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'grok-4.6', options: [] }] }

  it('signs in with the key after initialize when the key is what it has, and says it can be steered', async () => {
    const { connection, calls } = fakeConnection({ initialize: { protocolVersion: 1, _meta: { agentVersion: '1.0.62' } } })
    withGrok(connection, { apiKey: true })
    const initialized = await connection.agent.request('initialize', { protocolVersion: 1 })

    expect(calls.map(call => call.method)).toEqual(['initialize', 'authenticate'])
    expect(calls[1]!.params).toEqual({ methodId: 'xai.api_key' })
    expect(initialized._meta).toEqual({ agentVersion: '1.0.62', steering: { supported: true } })
  })

  it('in an environment on this computer\'s login, chooses grok.com, which runs the token command', async () => {
    const { connection, calls } = fakeConnection({})
    withGrok(connection, { apiKey: false, provider: true })
    await connection.agent.request('initialize', { protocolVersion: 1 })
    expect(calls.map(call => call.method)).toEqual(['initialize', 'authenticate'])
    expect(calls[1]!.params).toMatchObject({ methodId: 'grok.com' })
  })

  it('leaves sign-in to Grok\'s own login otherwise', async () => {
    const { connection, calls } = fakeConnection({})
    withGrok(connection, { apiKey: false })
    await connection.agent.request('initialize', { protocolVersion: 1 })
    expect(calls.map(call => call.method)).toEqual(['initialize'])
  })

  it('gives new and loaded sessions the four modes, on Default', async () => {
    const { connection } = fakeConnection({ 'session/new': NEW_SESSION, 'session/load': { configOptions: [] } })
    withGrok(connection, { apiKey: false })
    const created = await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })
    expect(availableModes(created).map(mode => mode.id)).toEqual(['default', 'always-approve', 'plan', 'ask'])
    expect(currentModeId(created)).toBe('default')
    expect(created.configOptions).toEqual(NEW_SESSION.configOptions)

    const loaded = await connection.agent.request('session/load', { sessionId: 'grk_1', cwd: '/tmp', mcpServers: [] })
    expect(availableModes(loaded)).toEqual(GROK_MODES.map(mode => ({ ...mode })))
  })

  it('sets always-approve as Grok\'s default mode with its prompts switched off, and any other mode with them on', async () => {
    const { connection, calls, notes } = fakeConnection({ 'session/new': NEW_SESSION })
    withGrok(connection, { apiKey: false })
    await connection.agent.request('session/new', { cwd: '/tmp', mcpServers: [] })

    await connection.agent.request('session/set_mode', { sessionId: 'grk_1', modeId: 'always-approve' })
    expect(calls.at(-1)).toEqual({ method: 'session/set_mode', params: { sessionId: 'grk_1', modeId: 'default' } })
    expect(notes.at(-1)).toEqual({ method: '_x.ai/yolo_mode_changed', params: { yolo_mode: true } })

    await connection.agent.request('session/set_mode', { sessionId: 'grk_1', modeId: 'plan' })
    expect(calls.at(-1)).toEqual({ method: 'session/set_mode', params: { sessionId: 'grk_1', modeId: 'plan' } })
    expect(notes.at(-1)).toEqual({ method: '_x.ai/yolo_mode_changed', params: { yolo_mode: false } })

    // A reload reports the mode Domo last set, not Grok's own default.
    await connection.agent.request('session/set_mode', { sessionId: 'grk_1', modeId: 'always-approve' })
    expect(currentModeId(await connection.agent.request('session/load', { sessionId: 'grk_1', cwd: '/tmp', mcpServers: [] }))).toBe('always-approve')
  })

  it('steers through _x.ai/interject, with the text beside the blocks', async () => {
    const { connection, calls } = fakeConnection({})
    withGrok(connection, { apiKey: false })
    const prompt = [{ type: 'text', text: 'Also end with STEERED.' }, { type: 'resource_link', uri: 'file:///w/a.ts', name: 'a.ts' }]
    const answer = await connection.agent.request('_session/steering', { sessionId: 'grk_1', prompt, _meta: { steering: { idleBehavior: 'promptRequired' } } })

    expect(calls).toEqual([{ method: '_x.ai/interject', params: { sessionId: 'grk_1', text: 'Also end with STEERED.\n\nfile:///w/a.ts', content: prompt } }])
    expect(answer).toEqual({ outcome: 'steered' })
  })
})

describe('what Grok signs in with, as the setup guide says it', () => {
  it('puts this computer\'s login first, and says what an environment would use', () => {
    expect(classifyGrok({ hostLogin: true, apiKey: false })).toMatchObject({ login: 'subscription', environments: true })
    expect(classifyGrok({ hostLogin: true, apiKey: true })).toMatchObject({ login: 'subscription', environments: true })
    expect(classifyGrok({ hostLogin: false, apiKey: true })).toMatchObject({ login: 'api-key', environments: true })
    expect(classifyGrok({ hostLogin: false, apiKey: false })).toMatchObject({ login: 'none', environments: false })
  })
})

describe('a failed Grok request', () => {
  it('says the reason Grok gives beside its bare "Internal error"', async () => {
    const { connection } = fakeConnection({})
    const refused = Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { message: 'API error (status 400 Bad Request): invalid-argument: Incorrect API key provided.', http_status: 400 }
    })
    connection.agent.request.mockRejectedValueOnce(refused)
    withGrok(connection, { apiKey: true })

    await expect(connection.agent.request('session/prompt', { sessionId: 'grk_1', prompt: [] }))
      .rejects.toMatchObject({ message: /Incorrect API key provided/, code: -32603 })
  })
})

describe('the token an environment\'s Grok borrows', () => {
  const jwt = (payload: object) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.')

  it('expires when the token says, and a token that does not say gets fifteen minutes', () => {
    expect(tokenExpiry(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000)
    expect(tokenExpiry('opaque', 1_000_000_000_000)).toBe(1_000_000_000 + 15 * 60)
  })

  it('is answered as Grok\'s external provider reads it: the access token, its life, and the issuer that makes it a grok.com session', () => {
    expect(providerAnswer('at', 1_000_000_600, 1_000_000_000_000)).toEqual({ access_token: 'at', expires_in: 600, issuer: 'https://auth.x.ai' })
    expect(providerAnswer('at', 1, 1_000_000_000_000).expires_in).toBe(0)
  })

  it('is fetched in the container with the runtime volume\'s node, so it needs nothing from the image', () => {
    const command = grokTokenCommand()
    expect(command.startsWith('/opt/domo/node/bin/node -e \'')).toBe(true)
    // One quoted argument for `sh -c`: no single quote inside it.
    expect(command.slice(command.indexOf('\'') + 1, -1)).not.toContain('\'')
  })
})
