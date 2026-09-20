import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Which model and voice the Live runtime actually asks Gemini for. The runtime
 * is real, and so are settings, the repo and Postgres; only the SDK is replaced,
 * by a recorder that returns a socket which does nothing. What a real Live
 * session does with the model is Google's business (and unreachable without an
 * account); what is Domo's business is *which id it sends*, and that is what
 * went wrong: a conversation kept the model it was created with after Settings
 * changed. Whether the default id *exists* is not testable here; that takes a
 * key and the network (`GET /api/models` lists what a key can use).
 */

const connect = vi.hoisted(() => vi.fn())

vi.mock('@google/genai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/genai')>()
  return {
    ...original,
    GoogleGenAI: class {
      live = { connect }
    }
  }
})

const { query } = await import('../../server/lib/db')
const { DEFAULTS, patchSettings } = await import('../../server/lib/settings')
const { createVoiceSession, getVoiceSession } = await import('../../server/lib/repo')
const { voiceManager } = await import('../../server/lib/voice/runtime')

async function connectedWith(voiceSessionId: string) {
  connect.mockClear()
  await voiceManager.get(voiceSessionId).ensureConnected()
  expect(connect).toHaveBeenCalledTimes(1)
  return connect.mock.calls[0]![0] as {
    model: string
    config: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } }
  }
}

beforeEach(() => {
  process.env.NUXT_GEMINI_API_KEY = 'test-key-not-real'
  connect.mockImplementation(async () => ({ close: vi.fn(), sendRealtimeInput: vi.fn() }))
})

afterEach(async () => {
  await voiceManager.shutdown()
  await query('delete from settings')
  await query('delete from voice_sessions')
  delete process.env.NUXT_GEMINI_API_KEY
})

describe('the model and voice the Live runtime connects with', () => {
  it('is the default on a fresh install', async () => {
    const session = await createVoiceSession()

    const request = await connectedWith(session.id)

    expect(request.model).toBe(DEFAULTS.liveModel)
    expect(request.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(DEFAULTS.voiceName)
  })

  it('follows a change in Settings, even for a conversation created before it', async () => {
    await patchSettings({ liveModel: 'gemini-old-live', voiceName: 'Puck' })
    const session = await createVoiceSession()
    expect(session.model).toBe('gemini-old-live')

    await patchSettings({ liveModel: 'gemini-new-live', voiceName: 'Leda' })
    const request = await connectedWith(session.id)

    expect(request.model).toBe('gemini-new-live')
    expect(request.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Leda')
  })

  it('records what it used on the conversation', async () => {
    await patchSettings({ liveModel: 'gemini-old-live' })
    const session = await createVoiceSession()
    await patchSettings({ liveModel: 'gemini-new-live' })

    await connectedWith(session.id)

    await vi.waitFor(async () => {
      expect((await getVoiceSession(session.id))?.model).toBe('gemini-new-live')
    })
  })

  it('applies the next Settings change on the next connect too', async () => {
    const session = await createVoiceSession()
    await patchSettings({ liveModel: 'gemini-first-live' })
    expect((await connectedWith(session.id)).model).toBe('gemini-first-live')

    await voiceManager.close(session.id)
    await patchSettings({ liveModel: 'gemini-second-live' })

    expect((await connectedWith(session.id)).model).toBe('gemini-second-live')
  })
})
