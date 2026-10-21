import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adapterEnv, adapterLaunch, GROK_ARGS, grokBinary } from '../../server/lib/acp/adapter-process'
import { GROK_MODES, withGrok } from '../../server/lib/acp/grok'
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

  it('on the host, leaves the key out while there is a grok login, so the plan is what bills', async () => {
    rememberSecretSettings({ ...NO_SECRETS, xaiApiKey: 'xai-stored' })
    const env = await adapterEnv('grok', false, noGh, noOpenCode, loggedIn)
    expect(env.XAI_API_KEY).toBeUndefined()
    expect(env.GROK_DISABLE_AUTOUPDATER).toBe('1')
  })

  it('on the host with no login, signs in with the saved key', async () => {
    rememberSecretSettings({ ...NO_SECRETS, xaiApiKey: 'xai-stored' })
    const env = await adapterEnv('grok', false, noGh, noOpenCode, loggedOut)
    expect(env.XAI_API_KEY).toBe('xai-stored')
  })

  it('in an environment, has the key or nothing, whatever this computer is logged into', async () => {
    const asked = vi.fn(loggedIn)
    expect((await adapterEnv('grok', true, noGh, noOpenCode, asked)).XAI_API_KEY).toBeUndefined()
    rememberSecretSettings({ ...NO_SECRETS, xaiApiKey: 'xai-stored' })
    expect((await adapterEnv('grok', true, noGh, noOpenCode, asked)).XAI_API_KEY).toBe('xai-stored')
    expect(asked).not.toHaveBeenCalled()
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
    expect(classifyGrok({ hostLogin: true, apiKey: false })).toMatchObject({ login: 'subscription', environments: false })
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
