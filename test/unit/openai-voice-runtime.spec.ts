import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { base64FromPcm16, pcm16FromBase64 } from '../../server/lib/voice/audio'

/**
 * What the voice runtime says and does on a GPT-Live socket.
 *
 * Same shape as `voice-runtime-notes.spec.ts` for the other provider: the
 * vendor module is a recorder (`ws` here, `@google/genai` there), the database
 * and the settings are fakes, and everything between the socket and the repo
 * is the real thing. A real Live session needs a microphone and an account, so
 * what is pinned is the wire: which events go out, and what arriving ones do
 * to the conversation.
 *
 * The protocol is not the Gemini one with different names, and most of what is
 * checked here is a consequence of that. The live model holds no tools and
 * delegates; results go back as *appended context* rather than as turns;
 * nothing on the wire marks the end of an exchange, so Domo decides where one
 * is; and occupancy arrives as a ratio with no token counts behind it.
 */

/* --------------------------- the fake socket --------------------------- */

const sockets = vi.hoisted(() => [] as Array<{
  url: string
  options: any
  sent: any[]
  closed: boolean
  deliver: (event: any) => void
}>)

/** Set to make the next `session.start` be refused, as a bad voice or model is. */
const refuseStart = vi.hoisted(() => ({ error: null as any }))

vi.mock('ws', () => ({
  default: class FakeWebSocket {
    sent: any[] = []
    listeners = new Map<string, Array<(...args: any[]) => void>>()
    closed = false

    constructor(public url: string, public options: any) {
      sockets.push(this as any)
      // The real socket opens on the next tick, which is what gives the
      // caller time to register its handlers first.
      queueMicrotask(() => this.fire('open'))
    }

    on(event: string, listener: (...args: any[]) => void) {
      const existing = this.listeners.get(event) ?? []
      existing.push(listener)
      this.listeners.set(event, existing)
      return this
    }

    send(data: string) {
      this.sent.push(JSON.parse(data))
      // `session.start` is answered, so the connect can finish.
      const event = JSON.parse(data)
      if (event.type === 'session.start') {
        queueMicrotask(() => this.deliver(refuseStart.error
          ? { type: 'error', error: refuseStart.error }
          : {
              type: 'session.started',
              event_id: 'ev_started',
              session: { id: 'live_1', model: event.session.model, status: 'active' }
            }))
      }
      if (event.type === 'session.close') {
        queueMicrotask(() => this.deliver({ type: 'session.closed', usage: { seconds: 42 } }))
      }
    }

    close() {
      this.closed = true
    }

    fire(event: string, ...args: any[]) {
      for (const listener of this.listeners.get(event) ?? []) listener(...args)
    }

    deliver(event: any) {
      this.fire('message', JSON.stringify(event))
    }
  }
}))

/* ------------------------------ the fakes ------------------------------ */

const setVoiceUsage = vi.hoisted(() => vi.fn(async () => {}))
const appendVoiceMessage = vi.hoisted(() => vi.fn(async (row: any) => ({ id: 'vm_1', seq: 1, ...row })))

vi.mock('../../server/lib/repo', () => ({
  appendVoiceMessage,
  getResumptionHandle: async () => ({ handle: null, fingerprint: null }),
  getVoiceSession: async () => null,
  countVoiceMessagesAfter: async () => 0,
  listVoiceMessagesAfter: async () => [],
  saveConversationSummary: async () => null,
  listAgentSessions: async () => [],
  listVoiceMessages: async () => [],
  setVoiceUsage,
  updateVoiceSession: async () => {}
}))

const delegation = vi.hoisted(() => ({
  target: 'responses' as 'responses' | 'agent',
  responsesModel: 'gpt-5.6-sol',
  reasoningEffort: 'high',
  agentSessionId: '',
  agentAdapter: 'claude-code',
  agentDevEnvironmentId: ''
}))

vi.mock('../../server/lib/settings', () => ({
  getSettings: async () => ({
    voiceProvider: 'openai',
    openaiLiveModel: 'gpt-live-1',
    openaiVoiceName: 'vesper',
    openaiDelegation: delegation,
    systemInstruction: 'be brief',
    defaultCwd: '/work',
    language: 'en-US',
    autoTitle: false,
    proactiveNotifications: false
  })
}))

vi.mock('../../server/lib/voice/mcp', () => ({
  connectVoiceMcpServers: async () => ({ tools: [], connections: [], errors: [] }),
  mcpFunctionTools: async () => ({ tools: [], handlers: {} })
}))

const toolCalls = vi.hoisted(() => [] as Array<{ name: string, args: any }>)

vi.mock('../../server/lib/voice/tools', () => ({
  voiceToolDeclarations: () => [
    {
      name: 'list_agent_sessions',
      description: 'List the coding agents',
      parameters: { type: 'OBJECT', properties: { archived: { type: 'BOOLEAN' } } }
    }
  ],
  voiceTools: {
    list_agent_sessions: {
      handler: async (args: any) => {
        toolCalls.push({ name: 'list_agent_sessions', args })
        return { agents: [] }
      }
    }
  }
}))

/** The delegate is exercised on its own; here only that it is asked matters. */
const asked = vi.hoisted(() => [] as Array<{ delegationId: string | null, typed?: string | null }>)

vi.mock('../../server/lib/voice/delegation', () => ({
  AgentDelegate: class {
    constructor(public options: any) {}
    async ask(delegationId: string | null, typed?: string | null) {
      asked.push({ delegationId, typed })
      this.options.onNote?.('Asked Voice thinking · test to work this out.')
      this.options.onUpdate({ delegationId, kind: 'commentary', text: 'Two agents are running.' })
    }

    close() {}
  }
}))

const { voiceManager } = await import('../../server/lib/voice/runtime')

let runtimeId = 0

function socket() {
  return sockets[sockets.length - 1]!
}

/** Everything the runtime has sent on the current socket, in order. */
function sent(type?: string) {
  return socket().sent.filter((event: any) => !type || event.type === type)
}

async function flush() {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
}

async function connected() {
  const runtime = voiceManager.get(`vs_${++runtimeId}`)
  await runtime.ensureConnected()
  return runtime
}

beforeEach(() => {
  process.env.NUXT_OPENAI_API_KEY = 'test-key-not-real'
  sockets.length = 0
  toolCalls.length = 0
  asked.length = 0
  delegation.target = 'responses'
  refuseStart.error = null
  setVoiceUsage.mockClear()
  appendVoiceMessage.mockClear()
})

afterEach(async () => {
  vi.useRealTimers()
  await voiceManager.shutdown()
  delete process.env.NUXT_OPENAI_API_KEY
})

describe('starting a GPT-Live session', () => {
  it('sends session.start first and waits for session.started', async () => {
    await connected()

    const start = sent('session.start')[0]
    expect(start.session.model).toBe('gpt-live-1')
    expect(start.session.audio.output.voice).toBe('vesper')
    expect(start.session.instructions).toContain('be brief')
    // …and the live model is told it holds no tools, because the operator's
    // instruction is written for one that does.
    expect(start.session.instructions).toContain('you do not call tools')
    expect(socket().url).toBe('wss://api.openai.com/v1/live/sessions')
    expect(socket().options.headers.Authorization).toBe('Bearer test-key-not-real')
  })

  it('asks for one PCM format at the rate the browser plays at', async () => {
    await connected()

    // One rate governs both directions, and the browser's playback context is
    // fixed at 24 kHz — so the microphone's 16 kHz is what gets resampled.
    expect(sent('session.start')[0].session.audio.format).toEqual({ type: 'audio/pcm', rate: 24000 })
  })

  it('configures the managed backend with Domo\'s own tools, converted', async () => {
    await connected()

    const { delegation: configured } = sent('session.start')[0].session
    expect(configured.type).toBe('responses')
    // The backend gets the instruction unqualified: it is the one that holds
    // the tools the instruction talks about.
    expect(configured.responses.instructions).toContain('be brief')
    expect(configured.responses.instructions).not.toContain('you do not call tools')
    expect(configured.responses.model).toBe('gpt-5.6-sol')
    expect(configured.responses.reasoning).toEqual({ effort: 'high' })
    expect(configured.responses.tools).toEqual([{
      type: 'function',
      name: 'list_agent_sessions',
      description: 'List the coding agents',
      parameters: { type: 'object', properties: { archived: { type: 'boolean' } } }
    }])
  })

  it('asks for client delegation, and no tools, when a coding agent does the thinking', async () => {
    delegation.target = 'agent'

    await connected()

    expect(sent('session.start')[0].session.delegation).toEqual({ type: 'client' })
    // And it is told the backend is a coding agent that takes its time, which
    // is the difference a listener actually hears.
    expect(sent('session.start')[0].session.instructions).toContain('coding agent')
  })

  it('fails the connect when the session is rejected, rather than opening a dead conversation', async () => {
    refuseStart.error = { message: 'Unknown voice', code: 'invalid_value' }
    const runtime = voiceManager.get(`vs_${++runtimeId}`)

    await expect(runtime.ensureConnected()).rejects.toThrow(/Unknown voice \(invalid_value\)/)
    expect(runtime.live).toBe(false)
  })
})

describe('audio', () => {
  it('resamples the microphone from 16 kHz to the session rate', async () => {
    const runtime = await connected()
    const samples = new Int16Array(1024).fill(1000)

    await runtime.sendAudioChunk(base64FromPcm16(samples))

    const appended = sent('session.input_audio.append')
    expect(appended).toHaveLength(1)
    expect(pcm16FromBase64(appended[0].audio)).toHaveLength(1536)
  })

  it('plays what the model says, at the rate it was encoded in', async () => {
    const runtime = await connected()
    const heard: any[] = []
    runtime.addListener(message => heard.push(message))

    socket().deliver({
      type: 'session.output_audio.delta',
      delta: base64FromPcm16(Int16Array.from([1, 2, 3]))
    })
    await flush()

    expect(heard.filter(message => message.type === 'audio')).toEqual([
      { type: 'audio', data: base64FromPcm16(Int16Array.from([1, 2, 3])), sampleRate: 24000 }
    ])
  })
})

describe('transcripts', () => {
  it('accumulates both sides and stores them once the conversation goes quiet', async () => {
    vi.useFakeTimers()
    const runtime = await connected()

    socket().deliver({ type: 'session.input_transcript.delta', delta: 'how are ' })
    socket().deliver({ type: 'session.input_transcript.delta', delta: 'the tests' })
    socket().deliver({ type: 'session.output_transcript.delta', delta: 'they pass' })
    await vi.advanceTimersByTimeAsync(0)

    // Nothing is committed while deltas are still arriving: the protocol has
    // no turn boundary, so a gap is the only thing that can be one.
    expect(stored('user')).toEqual([])

    await vi.advanceTimersByTimeAsync(2100)
    await flush()

    expect(stored('user')).toEqual(['how are the tests'])
    expect(stored('assistant')).toEqual(['they pass'])
    void runtime
  })

  it('does not commit half a sentence because the speaker paused', async () => {
    vi.useFakeTimers()
    await connected()

    socket().deliver({ type: 'session.input_transcript.delta', delta: 'can you also' })
    await vi.advanceTimersByTimeAsync(1500)
    socket().deliver({ type: 'session.input_transcript.delta', delta: ' check the build' })
    await vi.advanceTimersByTimeAsync(1500)
    await flush()

    expect(stored('user')).toEqual([])

    await vi.advanceTimersByTimeAsync(700)
    await flush()

    expect(stored('user')).toEqual(['can you also check the build'])
  })
})

describe('closing', () => {
  it('stores what was being said when the socket went', async () => {
    vi.useFakeTimers()
    const runtime = await connected()
    socket().deliver({ type: 'session.input_transcript.delta', delta: 'wait, actually' })
    await vi.advanceTimersByTimeAsync(0)

    // Closing well inside the idle window: nothing else would have stored it.
    await voiceManager.close(runtime.voiceSessionId)

    expect(stored('user')).toEqual(['wait, actually'])
  })

  it('asks the session to end rather than dropping the socket', async () => {
    const runtime = await connected()

    await voiceManager.close(runtime.voiceSessionId)

    expect(sent('session.close')).toHaveLength(1)
  })
})

describe('the managed backend\'s tool calls', () => {
  it('runs a finished function call and continues the response with its result', async () => {
    await connected()

    socket().deliver({
      type: 'response.event',
      delegation_id: 'item_1',
      // No nested `response` — measured against the real API, the item events
      // carry none. Putting one here is what let the delegation-id keying bug
      // through the first time.
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'list_agent_sessions',
          arguments: '{"archived":true}'
        }
      }
    })
    socket().deliver({
      type: 'response.event',
      delegation_id: 'item_1',
      event: { type: 'response.completed', response: { id: 'resp_1' } }
    })
    await vi.waitFor(() => expect(sent('response.create')).toHaveLength(1))

    expect(toolCalls).toEqual([{ name: 'list_agent_sessions', args: { archived: true } }])
    expect(sent('response.item.create')[0].item).toEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: JSON.stringify({ agents: [] })
    })
  })

  it('logs the call to the transcript, exactly as the other provider does', async () => {
    await connected()

    socket().deliver({
      type: 'response.event',
      delegation_id: 'item_2',
      event: {
        type: 'response.output_item.done',
        item: { type: 'function_call', call_id: 'call_2', name: 'list_agent_sessions', arguments: '{}' }
      }
    })
    socket().deliver({
      type: 'response.event',
      delegation_id: 'item_2',
      event: { type: 'response.completed', response: { id: 'resp_2' } }
    })
    await vi.waitFor(() => expect(stored('tool')).toHaveLength(1))

    const row = appendVoiceMessage.mock.calls.map(call => call[0]).find(row => row.role === 'tool')
    expect(row.toolName).toBe('list_agent_sessions')
  })

  it('does not continue a response that called nothing', async () => {
    await connected()

    socket().deliver({ type: 'response.event', event: { type: 'response.completed', response: { id: 'resp_3' } } })
    await flush()

    expect(sent('response.create')).toEqual([])
  })
})

describe('client delegation', () => {
  beforeEach(() => {
    delegation.target = 'agent'
  })

  it('hands a delegation to the coding agent and appends what it answers', async () => {
    await connected()

    socket().deliver({
      type: 'session.delegation.created',
      offset_ms: 1000,
      delegation: { id: 'item_9', type: 'delegation', target: 'client' }
    })
    await vi.waitFor(() => expect(asked).toHaveLength(1))

    expect(asked[0]).toEqual({ delegationId: 'item_9', typed: undefined })
    expect(sent('session.commentary.append')[0]).toEqual({
      type: 'session.commentary.append',
      delegation_id: 'item_9',
      content: 'Two agents are running.'
    })
  })

  it('records which agent was asked in the conversation\'s own transcript', async () => {
    await connected()

    socket().deliver({
      type: 'session.delegation.created',
      delegation: { id: 'item_9', target: 'client' }
    })
    await vi.waitFor(() => expect(stored('system')).toHaveLength(1))

    expect(stored('system')[0]).toContain('Asked Voice thinking')
  })

  it('sends typed input to the agent rather than to a backend it does not have', async () => {
    const runtime = await connected()

    await runtime.sendText('restart the auth agent')
    await flush()

    expect(asked).toEqual([{ delegationId: null, typed: 'restart the auth agent' }])
    expect(sent('response.create')).toEqual([])
  })
})

describe('typed input', () => {
  it('asks for an answer out loud when spoken replies are on', async () => {
    const runtime = await connected()

    await runtime.sendText('what is running', true)
    await flush()

    // An instruction, not a `thinking` note: measured against the real API,
    // appending typed input quietly gets the backend to answer and the live
    // model to say nothing at all. Being asked is what produces speech.
    const instruction = sent('session.instructions.append')[0]
    expect(instruction.content).toContain('what is running')
    expect(instruction.content).toMatch(/out loud/i)
    expect(sent('session.thinking.append')).toEqual([])
    // …and the backend is still queued and run, either way.
    expect(sent('response.item.create')).toHaveLength(1)
    expect(sent('response.create')).toHaveLength(1)
  })

  it('keeps it silent when they are off, and still answers the backend', async () => {
    const runtime = await connected()

    await runtime.sendText('what is running', false)
    await flush()

    expect(sent('session.instructions.append')).toEqual([])
    expect(sent('session.thinking.append')[0].content).toContain('what is running')
    expect(sent('response.item.create')).toHaveLength(1)
    expect(sent('response.create')).toHaveLength(1)
  })
})

describe('notes', () => {
  it('goes out at once, even while the model is speaking', async () => {
    const runtime = await connected()
    socket().deliver({ type: 'session.output_audio.delta', delta: base64FromPcm16(Int16Array.from([1])) })
    await flush()

    await runtime.injectNote('the auth agent finished')

    // Nothing is held: an append is designed to arrive mid-sentence, unlike
    // Gemini's client content, which pre-empts what is being generated.
    expect(sent('session.commentary.append')[0].content).toBe('the auth agent finished')
  })

  it('keeps a silent note silent, in its own append', async () => {
    const runtime = await connected()

    await runtime.injectNote('background detail', false)

    expect(sent('session.thinking.append')[0]).toEqual({
      type: 'session.thinking.append',
      delegation_id: null,
      content: 'background detail'
    })
    expect(sent('session.commentary.append')).toEqual([])
  })
})

describe('usage', () => {
  it('records the ratio the API reports, and no token count behind it', async () => {
    const runtime = await connected()

    socket().deliver({
      type: 'session.usage.updated',
      usage: { seconds: 61.5 },
      context_window: { usage_ratio: 0.41 }
    })
    await flush()
    await voiceManager.close(runtime.voiceSessionId)

    const written = setVoiceUsage.mock.calls.map((call: any[]) => call[1])
    expect(written.at(-1)).toMatchObject({
      context: { used: 0, size: null, percent: 41 }
    })
  })

  it('keeps the final audio total the session reports on its way out', async () => {
    const runtime = await connected()
    socket().deliver({ type: 'session.usage.updated', context_window: { usage_ratio: 0.1 } })
    await flush()

    await voiceManager.close(runtime.voiceSessionId)

    const written = setVoiceUsage.mock.calls.map((call: any[]) => call[1])
    expect(written.at(-1)!.audioSeconds).toBe(42)
  })
})

/** The text of every transcript row stored with this role, in order. */
function stored(role: string): string[] {
  return appendVoiceMessage.mock.calls
    .map(call => call[0])
    .filter((row: any) => row.role === role)
    .map((row: any) => row.text)
}
