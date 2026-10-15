import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'
import type { AgentVoiceSettings } from '../../shared/types'

/**
 * What a transcriber is asked, with the speech detector and Gemini stubbed:
 * nothing for audio in which nobody spoke, and the project's terms as
 * spelling hints, never the conversation as dialogue to go on with.
 */

const voiced = vi.hoisted(() => ({ seconds: 2 as number | null }))
const requestLocalModel = vi.hoisted(() => vi.fn(async (_request: any) => voiced.seconds))
vi.mock('../../server/lib/agent-voice/local-models', () => ({ requestLocalModel }))
vi.mock('../../server/lib/gemini', () => ({ geminiApiKey: () => 'test-key' }))
const generateContent = vi.hoisted(() => vi.fn(async (_request: any) => ({ candidates: [{ content: { parts: [{ text: 'run the tests' }] } }] })))
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContent } } }))

const { transcribeWith } = await import('../../server/lib/agent-voice/speech')

const settings = { ...DEFAULT_AGENT_VOICE, transcriber: 'gemini', language: 'en' } as AgentVoiceSettings
const context = {
  conversation: 'Developer: Write five sentences about the moon.\nAgent: The moon is Earth\'s only natural satellite.',
  vocabulary: ['useAgentVoice', 'Kokoro']
}

beforeEach(() => {
  voiced.seconds = 2
  vi.clearAllMocks()
})

describe('transcribing a turn', () => {
  it('asks no transcriber about audio in which the speech detector hears nobody', async () => {
    voiced.seconds = 0
    expect(await transcribeWith(settings, new Int16Array(32000), 16000, { context })).toBe('')
    expect(requestLocalModel).toHaveBeenCalledWith(expect.objectContaining({ op: 'speech' }))
    expect(generateContent).not.toHaveBeenCalled()
  })

  it('transcribes everything when the speech detector cannot be had, and audio it cannot read', async () => {
    voiced.seconds = null
    expect(await transcribeWith(settings, new Int16Array(32000), 16000)).toBe('run the tests')
    requestLocalModel.mockClear()
    // The voice check hears the speaker's own 24 kHz.
    expect(await transcribeWith(settings, new Int16Array(48000), 24000)).toBe('run the tests')
    expect(requestLocalModel).not.toHaveBeenCalled()
  })

  it('tells Gemini it is a transcriber, with the terms as spelling hints and without the conversation', async () => {
    expect(await transcribeWith(settings, new Int16Array(32000), 16000, { context })).toBe('run the tests')
    const request = generateContent.mock.calls[0]![0]
    const instruction: string = request.config.systemInstruction
    expect(instruction).toContain('speech-to-text engine, not an assistant')
    expect(instruction).toContain('in English')
    expect(instruction).toContain('useAgentVoice, Kokoro')
    expect(request.config.temperature).toBe(0)
    expect(JSON.stringify(request)).not.toContain('moon')
  })
})
