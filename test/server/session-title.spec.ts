import { EventEmitter } from 'node:events'
import { PassThrough, Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentSession, getAgentSession, updateAgentSession } from '../../server/lib/repo'
import { patchSettings } from '../../server/lib/settings'
import { askForTitle, cleanTitle, nameSessionInBackground, resolveTitler } from '../../server/lib/acp/session-title'

/**
 * The title writer is a throwaway ACP session. Driven here against the SDK's
 * own agent side over a pair of pipes, so what is checked is what a real
 * adapter would be sent; nothing is spawned and no account is touched.
 */

const state = vi.hoisted(() => ({ spawned: [] as Array<{ adapter: any, env: NodeJS.ProcessEnv }>, serve: null as any }))

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const adapter = new FakeAdapter()
      state.spawned.push({ adapter, env: options.env })
      state.serve?.(adapter)
      return adapter
    }
  }
})

class FakeAdapter extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 4242
  killed = false

  kill(): boolean {
    if (this.killed) return false
    this.killed = true
    this.emit('exit', 0, null)
    return true
  }

  stream() {
    return acp.ndJsonStream(
      Writable.toWeb(this.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(this.stdin) as ReadableStream<Uint8Array>
    )
  }
}

interface Script {
  models: string[]
  effort?: string[]
  modes?: string[]
  answer?: string
  /** Never answers the prompt. */
  hang?: boolean
}

/** What the fake was asked, in order. */
let calls: Array<{ method: string, params: any }>

function adapterServing(script: Script) {
  state.serve = (adapter: FakeAdapter) => {
    const current = { model: script.models[0], effort: script.effort?.[0] }
    const configOptions = () => [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current.model, options: script.models.map(value => ({ value, name: value })) },
      ...script.effort
        ? [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: current.effort, options: script.effort.map(value => ({ value, name: value })) }]
        : []
    ]
    acp.agent({ name: 'fake' })
      .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
      .onRequest(acp.methods.agent.session.new, (ctx: any) => {
        calls.push({ method: 'new', params: ctx.params })
        return {
          sessionId: 'acp_title',
          configOptions: configOptions(),
          ...script.modes ? { modes: { currentModeId: script.modes[0], availableModes: script.modes.map(id => ({ id, name: id })) } } : {}
        } as any
      })
      .onRequest(acp.methods.agent.session.setConfigOption, (ctx: any) => {
        calls.push({ method: 'config', params: ctx.params })
        if (ctx.params.configId === 'model') current.model = ctx.params.value
        if (ctx.params.configId === 'effort') current.effort = ctx.params.value
        return { configOptions: configOptions() } as any
      })
      .onRequest(acp.methods.agent.session.setMode, (ctx: any) => {
        calls.push({ method: 'mode', params: ctx.params })
        return {}
      })
      .onRequest(acp.methods.agent.session.prompt, async (ctx: any) => {
        calls.push({ method: 'prompt', params: ctx.params })
        if (script.hang) await new Promise(() => {})
        for (const piece of (script.answer ?? '').match(/.{1,4}/gs) ?? []) {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } }
          })
        }
        return { stopReason: 'end_turn' }
      })
      .connect(adapter.stream())
  }
}

const promptText = (params: any): string => params.prompt.map((block: any) => block.text).join('')

beforeEach(() => {
  calls = []
  state.spawned = []
  state.serve = null
})

afterEach(() => {
  delete process.env.NUXT_ANTHROPIC_API_KEY
  delete process.env.NUXT_OPENAI_API_KEY
})

describe('asking for a title', () => {
  it('gives Claude Code the instructions as its system prompt, with no tools, settings, MCP servers or transcript', async () => {
    adapterServing({ models: ['default', 'haiku'], effort: ['default', 'low', 'high'], answer: 'Fix the flaky login test' })
    // Billed per token, so never handed to a titler, logged in or not.
    process.env.NUXT_ANTHROPIC_API_KEY = 'sk-ant-test'

    const answer = await askForTitle('the login test fails one run in five, can you look?', { adapter: 'claude-code', model: 'haiku' })

    expect(answer).toBe('Fix the flaky login test')
    expect(calls.map(call => call.method)).toEqual(['new', 'config', 'config', 'prompt'])
    const created = calls[0]!.params
    expect(created.mcpServers).toEqual([])
    expect(created._meta.systemPrompt).toContain('Reply with only a title')
    expect(created._meta.claudeCode.options).toEqual({ tools: [], settingSources: [], strictMcpConfig: true, persistSession: false })
    expect(calls[1]!.params).toMatchObject({ configId: 'model', value: 'haiku' })
    expect(calls[2]!.params).toMatchObject({ configId: 'effort', value: 'low' })
    expect(promptText(calls[3]!.params)).toBe('the login test fails one run in five, can you look?')
    expect(state.spawned[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(state.spawned[0]!.adapter.killed).toBe(true)
  })

  it('puts the instructions ahead of the message for a harness without a system prompt, in a read-only mode', async () => {
    adapterServing({
      models: ['gpt-5.6-terra', 'gpt-5.6-luna'],
      effort: ['low', 'medium'],
      modes: ['agent', 'read-only'],
      answer: '"Add dark mode."\n\nThat is my title.'
    })
    process.env.NUXT_OPENAI_API_KEY = 'sk-openai-test'

    const answer = await askForTitle('add a dark mode toggle', { adapter: 'codex', model: 'gpt-5.6-luna' })

    expect(cleanTitle(answer)).toBe('Add dark mode')
    expect(calls[0]!.params._meta).toBeUndefined()
    // Already on its least effort: nothing to change.
    expect(calls.map(call => call.method)).toEqual(['new', 'config', 'mode', 'prompt'])
    expect(calls[2]!.params).toMatchObject({ modeId: 'read-only' })
    const text = promptText(calls[3]!.params)
    expect(text).toMatch(/^You name coding-agent sessions/)
    expect(text).toContain('<message>\nadd a dark mode toggle\n</message>')
    expect(state.spawned[0]!.env.OPENAI_API_KEY).toBeUndefined()
    expect(state.spawned[0]!.env.CODEX_API_KEY).toBeUndefined()
  })

  it('fails rather than titling on a model nobody chose, and gives up after its time', async () => {
    adapterServing({ models: ['sonnet'] })
    await expect(askForTitle('hi', { adapter: 'claude-code', model: 'haiku' })).rejects.toThrow('does not offer haiku')
    expect(state.spawned[0]!.adapter.killed).toBe(true)

    adapterServing({ models: ['haiku'], hang: true })
    await expect(askForTitle('hi', { adapter: 'claude-code', model: 'haiku' }, 200)).rejects.toThrow('no title within')
    expect(state.spawned[1]!.adapter.killed).toBe(true)
  })
})

describe('cleaning the answer', () => {
  it('keeps one plain line and cuts it at a word', () => {
    expect(cleanTitle('Title: **Fix login**')).toBe('Fix login')
    expect(cleanTitle('\n# “Refactor the parser”.\nmore')).toBe('Refactor the parser')
    expect(cleanTitle('   ')).toBe('')
    const long = cleanTitle('Investigate why the nightly integration build times out on the arm64 runners again')
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long).toBe('Investigate why the nightly integration build times out on')
  })
})

describe('naming a session in the background', () => {
  beforeEach(async () => {
    await patchSettings({ sessionTitles: { enabled: true, adapter: 'claude-code', model: 'haiku' } })
  })

  it('replaces the first words with the generated title', async () => {
    adapterServing({ models: ['haiku'], answer: 'Speed up the test suite' })
    const session = await createAgentSession({ adapter: 'codex', title: 'make the tests faster please', cwd: '/tmp', titlePlaceholder: true })

    nameSessionInBackground(session.id, 'make the tests faster please')

    await expect.poll(async () => (await getAgentSession(session.id))!.title).toBe('Speed up the test suite')
  })

  it('never replaces a title somebody set, even one set while it was being written', async () => {
    let answer!: () => void
    const held = new Promise<void>(resolve => (answer = resolve))
    adapterServing({ models: ['haiku'], answer: 'Generated' })
    const serve = state.serve
    // Hold the adapter until the rename has landed.
    state.serve = (adapter: FakeAdapter) => void held.then(() => serve(adapter))
    const session = await createAgentSession({ adapter: 'codex', title: 'first words', cwd: '/tmp', titlePlaceholder: true })

    nameSessionInBackground(session.id, 'first words')
    await updateAgentSession(session.id, { title: 'Mine' })
    answer()

    await expect.poll(() => calls.some(call => call.method === 'prompt')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await getAgentSession(session.id))!.title).toBe('Mine')
  })

  it('keeps the first words, silently, when the titler fails, and spawns nothing when titles are off', async () => {
    adapterServing({ models: ['sonnet'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = await createAgentSession({ adapter: 'codex', title: 'first words', cwd: '/tmp', titlePlaceholder: true })
    nameSessionInBackground(session.id, 'first words')
    await expect.poll(() => warn.mock.calls.length).toBe(1)
    expect((await getAgentSession(session.id))!.title).toBe('first words')
    warn.mockRestore()

    await patchSettings({ sessionTitles: { enabled: false, adapter: 'claude-code', model: 'haiku' } })
    expect(await resolveTitler({ enabled: false, adapter: 'claude-code', model: 'haiku' })).toBeNull()
    nameSessionInBackground(session.id, 'first words')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(state.spawned).toHaveLength(1)
  })
})
