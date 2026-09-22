import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What the voice runtime records about how full its context is.
 *
 * Same shape as `voice-runtime-notes.spec.ts`: the SDK is a recorder, the
 * database and the settings are fakes, and everything between the socket and
 * the repo is the real thing. A real Live session is out of scope for the suite
 * (it needs a microphone and an account), so what is pinned here is what the
 * runtime *does* with a `usageMetadata` frame.
 */

const connect = vi.hoisted(() => vi.fn())

vi.mock('@google/genai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/genai')>()
  return { ...original, GoogleGenAI: class { live = { connect } } }
})

const setVoiceUsage = vi.hoisted(() => vi.fn(async () => {}))
const updateVoiceSession = vi.hoisted(() => vi.fn(async () => {}))
const handle = vi.hoisted(() => ({ value: null as string | null, fingerprint: null as string | null }))

vi.mock('../../server/lib/repo', () => ({
  appendVoiceMessage: async (row: any) => ({ id: 'vm_1', ...row }),
  getResumptionHandle: async () => ({ handle: handle.value, fingerprint: handle.fingerprint }),
  getVoiceSession: async () => null,
  listAgentSessions: async () => [],
  listVoiceMessages: async () => [],
  setVoiceUsage,
  updateVoiceSession
}))

vi.mock('../../server/lib/settings', () => ({
  getSettings: async () => ({
    // A model the seeded table knows, so `size` is a real number here.
    liveModel: 'gemini-3.8-live',
    voiceName: 'Puck',
    systemInstruction: 'be brief',
    defaultCwd: '/work',
    language: 'en-US',
    autoTitle: false,
    proactiveNotifications: false
  })
}))

vi.mock('../../server/lib/voice/mcp', () => ({
  connectVoiceMcpServers: async () => ({ tools: [], connections: [], errors: [] })
}))

vi.mock('../../server/lib/voice/tools', () => ({
  voiceToolDeclarations: () => [],
  voiceTools: {}
}))

// The models API must not be reached from a test; the seeded table answers.
vi.mock('../../server/lib/gemini', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/lib/gemini')>(),
  ensureLiveContextWindows: async () => {}
}))

const { voiceManager } = await import('../../server/lib/voice/runtime')

let deliver: (message: any) => void
let runtimeId = 0

async function connected() {
  connect.mockImplementation(async (options: any) => {
    deliver = options.callbacks.onmessage
    return {
      close: vi.fn(),
      sendClientContent: vi.fn(),
      sendRealtimeInput: vi.fn(),
      sendToolResponse: vi.fn()
    }
  })
  const runtime = voiceManager.get(`vs_${++runtimeId}`)
  await runtime.ensureConnected()
  return runtime
}

async function flush() {
  for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
}

/** The readings actually written to the row, in order. */
function written() {
  return setVoiceUsage.mock.calls.map((call: any[]) => call[1])
}

beforeEach(() => {
  process.env.NUXT_GEMINI_API_KEY = 'test-key-not-real'
  handle.value = null
  handle.fingerprint = null
  setVoiceUsage.mockClear()
  updateVoiceSession.mockClear()
})

afterEach(async () => {
  await voiceManager.shutdown()
  delete process.env.NUXT_GEMINI_API_KEY
})

describe('recording the context window', () => {
  it('writes what a usageMetadata frame reports, with the model own window', async () => {
    await connected()
    deliver({ usageMetadata: { totalTokenCount: 12_345, promptTokenCount: 11_000 } })
    deliver({ serverContent: { turnComplete: true } })
    await flush()

    expect(written().at(-1)).toMatchObject({ context: { used: 12_345, size: 131_072 } })
  })

  it('falls back to promptTokenCount for a frame with no total', async () => {
    await connected()
    deliver({ usageMetadata: { promptTokenCount: 900 } })
    deliver({ serverContent: { turnComplete: true } })
    await flush()

    expect(written().at(-1)).toMatchObject({ context: { used: 900 } })
  })

  it('lets `used` fall, because sliding-window compression drops old turns', async () => {
    await connected()
    deliver({ usageMetadata: { totalTokenCount: 120_000 } })
    deliver({ serverContent: { turnComplete: true } })
    await flush()
    deliver({ usageMetadata: { totalTokenCount: 40_000 } })
    deliver({ serverContent: { turnComplete: true } })
    await flush()

    expect(written().map((usage: any) => usage.context.used)).toEqual([120_000, 40_000])
  })

  it('writes nothing for an unchanged reading', async () => {
    await connected()
    for (let i = 0; i < 3; i++) {
      deliver({ usageMetadata: { totalTokenCount: 5_000 } })
      deliver({ serverContent: { turnComplete: true } })
      await flush()
    }

    // `voice_sessions` is synced with REPLICA IDENTITY FULL, so a rewrite that
    // changes nothing still re-streams the whole row to every browser.
    expect(written().filter((usage: any) => usage.context.used === 5_000)).toHaveLength(1)
  })

  it('ignores a frame with no usable count', async () => {
    await connected()
    deliver({ usageMetadata: { totalTokenCount: 5_000 } })
    deliver({ serverContent: { turnComplete: true } })
    await flush()
    setVoiceUsage.mockClear()

    deliver({ usageMetadata: {} })
    deliver({ usageMetadata: { totalTokenCount: -1 } })
    deliver({ usageMetadata: { totalTokenCount: Number.NaN } })
    deliver({ serverContent: { turnComplete: true } })
    await flush()

    // The last good reading stands; a frame that says nothing changes nothing.
    expect(written()).toEqual([])
  })

  it('leaves updated_at, the title and the sidebar ordering alone', async () => {
    await connected()
    updateVoiceSession.mockClear()
    deliver({ usageMetadata: { totalTokenCount: 7_000 } })
    deliver({ serverContent: { turnComplete: true } })
    await flush()

    // A conversation nobody is speaking in must not climb the sidebar because
    // its token count moved.
    expect(setVoiceUsage).toHaveBeenCalled()
    expect(updateVoiceSession).not.toHaveBeenCalled()
  })

  it('starts a conversation with no resumption handle back at zero', async () => {
    await connected()
    deliver({ serverContent: { turnComplete: true } })
    await flush()

    // Fresh context means an empty window; leaving the previous number on
    // screen until the first frame arrives would be a lie for as long as it
    // lasted.
    expect(written()[0]).toMatchObject({ context: { used: 0, size: 131_072 } })
  })

  it('does not reset a conversation that really resumed its context', async () => {
    // A resume keeps the model's context, so the reading has to survive it.
    // The fingerprint has to be the *real* one — a mismatch starts fresh, which
    // is the whole reason it is stored next to the handle.
    await connected()
    deliver({ sessionResumptionUpdate: { newHandle: 'h1' } })
    await flush()
    const stored = updateVoiceSession.mock.calls
      .map((call: any[]) => call[1])
      .find((patch: any) => patch?.resumptionFingerprint)
    expect(stored).toBeTruthy()

    handle.value = stored.resumptionHandle
    handle.fingerprint = stored.resumptionFingerprint
    setVoiceUsage.mockClear()

    await connected()
    deliver({ serverContent: { turnComplete: true } })
    await flush()

    expect(written()).toEqual([])
  })
})
