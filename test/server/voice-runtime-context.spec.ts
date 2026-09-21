import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * What a reconnecting Live session is actually told about the conversation it
 * is rejoining.
 *
 * A socket lasts minutes and the conversation lasts as long as the user wants
 * it to, so every connect rebuilds the context from Postgres. This drives the
 * real runtime, the real repo and a real database, and replaces only Google:
 * `live.connect` is a recorder (as in `voice-runtime-model.spec.ts`) and
 * `models.generateContent` is the summariser. Nothing here touches the network.
 *
 * The regression it pins: the instruction used to carry the last twelve
 * messages verbatim and nothing else, so every reconnect of a long
 * conversation quietly dropped everything before them.
 */

const connect = vi.hoisted(() => vi.fn())
const generateContent = vi.hoisted(() => vi.fn())

vi.mock('@google/genai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/genai')>()
  return {
    ...original,
    GoogleGenAI: class {
      live = { connect }
      models = { generateContent }
    }
  }
})

const { query } = await import('../../server/lib/db')
const { appendVoiceMessage, createVoiceSession, getVoiceSession, saveConversationSummary }
  = await import('../../server/lib/repo')
const { voiceManager } = await import('../../server/lib/voice/runtime')

async function instructionFor(voiceSessionId: string): Promise<string> {
  connect.mockClear()
  await voiceManager.get(voiceSessionId).ensureConnected()
  expect(connect).toHaveBeenCalledTimes(1)
  return connect.mock.calls[0]![0].config.systemInstruction as string
}

/** Long enough that the whole transcript no longer fits a connect. */
async function longConversation(turns = 40) {
  const session = await createVoiceSession({ title: 'Invoice tests' })
  for (let i = 0; i < turns; i++) {
    await appendVoiceMessage({ sessionId: session.id, role: 'user', text: `Question ${i}. `.repeat(20) })
    await appendVoiceMessage({ sessionId: session.id, role: 'assistant', text: `Answer ${i}. `.repeat(20) })
  }
  return session
}

beforeEach(() => {
  process.env.NUXT_GEMINI_API_KEY = 'test-key-not-real'
  connect.mockImplementation(async () => ({ close: vi.fn(), sendRealtimeInput: vi.fn(), sendClientContent: vi.fn() }))
  generateContent.mockImplementation(async () => ({ text: 'They are chasing a flaky invoice test on branch fix/invoices.' }))
})

afterEach(async () => {
  await voiceManager.shutdown()
  generateContent.mockReset()
  await query('delete from settings')
  await query('delete from voice_sessions')
  delete process.env.NUXT_GEMINI_API_KEY
})

describe('the context a Live connect is given', () => {
  it('says nothing about earlier messages in a conversation that has none', async () => {
    const session = await createVoiceSession()

    const instruction = await instructionFor(session.id)

    expect(instruction).not.toContain('already under way')
    expect(generateContent).not.toHaveBeenCalled()
  })

  it('replays the recent messages verbatim', async () => {
    const session = await createVoiceSession()
    await appendVoiceMessage({ sessionId: session.id, role: 'user', text: 'is the deploy green' })
    await appendVoiceMessage({ sessionId: session.id, role: 'assistant', text: 'it went out ten minutes ago' })

    const instruction = await instructionFor(session.id)

    expect(instruction).toContain('already under way')
    expect(instruction).toContain('user: is the deploy green')
    expect(instruction).toContain('assistant: it went out ten minutes ago')
  })

  it('carries the stored summary instead of the messages it covers', async () => {
    const session = await createVoiceSession()
    const old = await appendVoiceMessage({ sessionId: session.id, role: 'user', text: 'the very first thing said' })
    await appendVoiceMessage({ sessionId: session.id, role: 'user', text: 'and the latest thing said' })
    await saveConversationSummary(session.id, { summary: 'They discussed the invoice importer.', throughSeq: old.seq })

    const instruction = await instructionFor(session.id)

    expect(instruction).toContain('They discussed the invoice importer.')
    expect(instruction).toContain('and the latest thing said')
    expect(instruction).not.toContain('the very first thing said')
  })

  it('folds a long conversation before connecting, rather than dropping its middle', async () => {
    const session = await longConversation()

    const instruction = await instructionFor(session.id)

    expect(generateContent).toHaveBeenCalledTimes(1)
    expect(instruction).toContain('They are chasing a flaky invoice test on branch fix/invoices.')
    expect(instruction).not.toContain('could not be kept')
    // The newest turn is still there word for word: a paraphrase of what the
    // user just said is not good enough.
    expect(instruction).toContain('Answer 39.')
    expect((await getVoiceSession(session.id))?.summaryThroughSeq).toBeGreaterThan(0)
  })

  it('keeps the socket when the summariser is unreachable, and says what was lost', async () => {
    const session = await longConversation()
    generateContent.mockRejectedValue(new Error('network is down'))

    const instruction = await instructionFor(session.id)

    expect(instruction).toContain('could not be kept')
    expect(instruction).toContain('Answer 39.')
    expect((await getVoiceSession(session.id))?.summary).toBeNull()
  })

  it('folds again in the background when a turn ends', async () => {
    const session = await createVoiceSession()
    await instructionFor(session.id)
    const callbacks = connect.mock.calls[0]![0].callbacks
    await longConversationInto(session.id)

    await callbacks.onmessage({ serverContent: { turnComplete: true } })

    await vi.waitFor(async () => {
      expect((await getVoiceSession(session.id))?.summary)
        .toContain('They are chasing a flaky invoice test on branch fix/invoices.')
    })
  })
})

async function longConversationInto(sessionId: string, turns = 40) {
  for (let i = 0; i < turns; i++) {
    await appendVoiceMessage({ sessionId, role: 'user', text: `Question ${i}. `.repeat(20) })
    await appendVoiceMessage({ sessionId, role: 'assistant', text: `Answer ${i}. `.repeat(20) })
  }
}
