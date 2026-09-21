import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * When a proactive note is allowed to reach the model.
 *
 * In the Live API, client content pre-empts whatever the model is generating,
 * so a note delivered mid-sentence truncates it — which is what the user heard
 * as the voice agent interrupting itself. The rule is one gate (a tool call is
 * pending, the model is mid-turn, or the user is still talking) and one drain,
 * coalescing whatever waited into a single message.
 *
 * Everything below the socket is real; the SDK is a recorder (the same trick as
 * `test/server/voice-runtime-model.spec.ts` uses for the model id) and the
 * database, the settings and the tools are fakes, because none of them is what
 * is under test here.
 */

const connect = vi.hoisted(() => vi.fn())

vi.mock('@google/genai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/genai')>()
  return { ...original, GoogleGenAI: class { live = { connect } } }
})

const appendVoiceMessage = vi.hoisted(() => vi.fn(async (row: any) => ({ id: 'vm_1', ...row })))

vi.mock('../../server/lib/repo', () => ({
  appendVoiceMessage,
  getResumptionHandle: async () => ({ handle: null, fingerprint: null }),
  getVoiceSession: async () => null,
  listAgentSessions: async () => [],
  listVoiceMessages: async () => [],
  updateVoiceSession: async () => {}
}))

vi.mock('../../server/lib/settings', () => ({
  getSettings: async () => ({
    liveModel: 'gemini-test-live',
    voiceName: 'Puck',
    systemInstruction: 'be brief',
    defaultCwd: '/work',
    language: 'en-US',
    autoTitle: false,
    proactiveNotifications: true
  })
}))

vi.mock('../../server/lib/voice/mcp', () => ({
  connectVoiceMcpServers: async () => ({ tools: [], connections: [], errors: [] })
}))

/** One tool, whose handler stays open until the test lets go of it. */
const toolGate = vi.hoisted(() => ({ release: null as null | (() => void) }))

vi.mock('../../server/lib/voice/tools', () => ({
  voiceToolDeclarations: () => [],
  voiceTools: {
    slow_tool: {
      handler: async () => {
        await new Promise<void>((resolve) => {
          toolGate.release = resolve
        })
        return { ok: true }
      }
    }
  }
}))

const { voiceManager } = await import('../../server/lib/voice/runtime')

interface Socket {
  close: ReturnType<typeof vi.fn>
  sendClientContent: ReturnType<typeof vi.fn>
  sendRealtimeInput: ReturnType<typeof vi.fn>
  sendToolResponse: ReturnType<typeof vi.fn>
}

let socket: Socket
let deliver: (message: any) => void
let runtimeId = 0

async function connected() {
  socket = {
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn()
  }
  connect.mockImplementation(async (options: any) => {
    deliver = options.callbacks.onmessage
    return socket
  })
  const runtime = voiceManager.get(`vs_${++runtimeId}`)
  await runtime.ensureConnected()
  return runtime
}

/**
 * Drain the runtime's message inbox, which is a promise chain over already
 * resolved fakes — so turning the microtask queue over is enough, and it works
 * under fake timers, where a timer-based flush would not.
 */
async function flush() {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
}

/** Push a `serverContent` message through the runtime and let it land. */
async function serverSays(content: any) {
  deliver({ serverContent: content })
  await flush()
}

/** Each client-content message the runtime has sent, as text plus its turn flag. */
function sent(): Array<{ text: string, turnComplete: boolean }> {
  return socket.sendClientContent.mock.calls.map((call: any[]) => ({
    text: call[0].turns[0].parts[0].text as string,
    turnComplete: !!call[0].turnComplete
  }))
}

/** The transcript rows written for notes, ignoring the spoken turn's own rows. */
function noteRows(): any[] {
  return appendVoiceMessage.mock.calls.map((call: any[]) => call[0]).filter(row => row.role === 'system')
}

beforeEach(() => {
  process.env.NUXT_GEMINI_API_KEY = 'test-key-not-real'
  toolGate.release = null
  appendVoiceMessage.mockClear()
})

afterEach(async () => {
  vi.useRealTimers()
  toolGate.release?.()
  await voiceManager.shutdown()
  delete process.env.NUXT_GEMINI_API_KEY
})

describe('injectNote', () => {
  it('sends a note straight through when nothing is going on', async () => {
    const runtime = await connected()

    await runtime.injectNote('agent finished')

    expect(sent()).toEqual([{ text: '[Domo system notice] agent finished', turnComplete: true }])
  })

  it('keeps `speak: false` meaning "context, do not answer it"', async () => {
    const runtime = await connected()

    await runtime.injectNote('for your information', false)

    expect(sent()[0]!.turnComplete).toBe(false)
  })

  it('holds a note while the model is generating, and delivers it on turnComplete', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })

    await runtime.injectNote('agent finished')
    expect(sent()).toEqual([])

    await serverSays({ turnComplete: true })

    expect(sent()).toEqual([{ text: '[Domo system notice] agent finished', turnComplete: true }])
  })

  it('treats a modelTurn part as the model generating too', async () => {
    const runtime = await connected()
    await serverSays({ modelTurn: { parts: [{ text: 'hello' }] } })

    await runtime.injectNote('agent finished')

    expect(sent()).toEqual([])
  })

  it('releases on generationComplete, without waiting for playback to end', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })
    await runtime.injectNote('agent finished')

    await serverSays({ generationComplete: true })

    expect(sent()).toHaveLength(1)
  })

  it('releases when the model is interrupted', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })
    await runtime.injectNote('agent finished')

    // `interrupted` on its own: a barge-in that has produced no transcription
    // yet, so it is the model gate being released and not the user one.
    await serverSays({ interrupted: true })

    expect(sent()).toHaveLength(1)
  })

  it('holds a note while the user is still speaking, and delivers it once they stop', async () => {
    const runtime = await connected()
    vi.useFakeTimers()
    await serverSays({ interimInputTranscription: { text: 'can you also' } })

    await runtime.injectNote('agent finished')
    expect(sent()).toEqual([])

    // Still inside the window: a gap this short is a pause mid-sentence.
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent()).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)

    expect(sent()).toEqual([{ text: '[Domo system notice] agent finished', turnComplete: true }])
  })

  it('delivers a note the user was holding up on the next completed turn, if that comes first', async () => {
    const runtime = await connected()
    await serverSays({ inputTranscription: { text: 'can you also' } })
    await runtime.injectNote('agent finished')
    expect(sent()).toEqual([])

    // The user's question was asked and answered well inside the silence
    // window, so it is the completed turn and not the timer that releases it.
    await serverSays({ outputTranscription: { text: 'sure' } })
    await serverSays({ turnComplete: true })

    expect(sent()).toHaveLength(1)
  })

  it('coalesces everything that waited into one client-content message', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })

    await runtime.injectNote('agent one finished')
    await runtime.injectNote('agent two needs a decision')
    await serverSays({ turnComplete: true })

    expect(sent()).toEqual([{
      text: '[Domo system notice] agent one finished\n\n[Domo system notice] agent two needs a decision',
      turnComplete: true
    }])
  })

  it('answers a coalesced batch when any note in it asked to be spoken', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })

    await runtime.injectNote('background detail', false)
    await runtime.injectNote('agent needs a decision', true)
    await serverSays({ turnComplete: true })

    expect(sent()[0]!.turnComplete).toBe(true)
  })

  it('stays quiet for a batch in which nothing asked to be spoken', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })

    await runtime.injectNote('background one', false)
    await runtime.injectNote('background two', false)
    await serverSays({ turnComplete: true })

    expect(sent()[0]!.turnComplete).toBe(false)
  })

  it('writes the transcript row when the note is made, not when it is delivered', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })

    await runtime.injectNote('agent one finished')
    await runtime.injectNote('agent two finished')

    // Both are on screen already, while neither has reached the model.
    expect(noteRows()).toHaveLength(2)
    expect(noteRows().every(row => row.meta.source === 'agent-activity')).toBe(true)
    expect(sent()).toEqual([])

    await serverSays({ turnComplete: true })

    // …and the coalesced delivery does not write them a second time.
    expect(noteRows()).toHaveLength(2)
    expect(sent()).toHaveLength(1)
  })

  it('holds a note while a tool call is pending and delivers it with the response', async () => {
    const runtime = await connected()
    deliver({ toolCall: { functionCalls: [{ id: 'fc_1', name: 'slow_tool', args: {} }] } })
    await vi.waitFor(() => expect(toolGate.release).toBeTypeOf('function'))

    await runtime.injectNote('agent finished')
    expect(sent()).toEqual([])
    expect(socket.sendToolResponse).not.toHaveBeenCalled()

    toolGate.release!()

    await vi.waitFor(() => {
      expect(socket.sendToolResponse).toHaveBeenCalledTimes(1)
      expect(sent()).toEqual([{ text: '[Domo system notice] agent finished', turnComplete: true }])
    })
  })

  it('sends nothing once the conversation is closed', async () => {
    const runtime = await connected()
    await serverSays({ outputTranscription: { text: 'I was saying' } })
    await runtime.injectNote('agent finished')

    await runtime.close()
    await runtime.injectNote('and another thing')
    // A release arriving after the close must not resurrect the held note.
    await serverSays({ turnComplete: true })

    expect(socket.sendClientContent).not.toHaveBeenCalled()
  })
})
