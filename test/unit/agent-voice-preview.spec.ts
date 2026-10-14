import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE, VOICE_PREVIEW_TEXT } from '../../shared/agent-voice'

const synthesizeWith = vi.fn(async (_settings: any, _text: string, onChunk: (chunk: { data: string, sampleRate: number }) => void) => {
  onChunk({ data: Buffer.from(new Int16Array([1, 2, 3]).buffer).toString('base64'), sampleRate: 24000 })
})
let geminiKey: string | null = null
vi.mock('../../server/lib/settings', () => ({
  getSettings: async () => ({ agentVoice: { ...DEFAULT_AGENT_VOICE, speaker: 'local' } }),
  normalizeAgentVoice: (value: any) => ({ ...DEFAULT_AGENT_VOICE, ...value })
}))
vi.mock('../../server/lib/gemini', () => ({ geminiApiKey: () => geminiKey }))
vi.mock('../../server/lib/openai', () => ({ openAiApiKey: () => null }))
vi.mock('../../server/lib/repo', () => ({ getAssistantOfSession: async () => null }))
vi.mock('../../server/lib/agent-voice/voice-store', () => ({
  getClonedVoice: async (id: string) => id === 'abcdefabcdef' ? { id, name: 'Mine', seconds: 12 } : null,
  listClonedVoices: async () => []
}))
vi.mock('../../server/lib/agent-voice/speech', async original => ({
  ...(await original<typeof import('../../server/lib/agent-voice/speech')>()),
  synthesizeWith
}))

const { previewVoice, PreviewError } = await import('../../server/lib/agent-voice/preview')

describe('previewing a voice', () => {
  beforeEach(() => {
    synthesizeWith.mockClear()
    geminiKey = null
    delete process.env.HF_TOKEN
  })

  it('speaks the sample line in the Settings form\'s voice, saved or not, as a WAV', async () => {
    const wav = await previewVoice({ agentVoice: { speaker: 'openai', openaiVoice: 'sage' } })
    expect(synthesizeWith).toHaveBeenCalledWith(expect.objectContaining({ speaker: 'openai', openaiVoice: 'sage' }), VOICE_PREVIEW_TEXT, expect.any(Function), undefined)
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(24000)
    expect(wav.length).toBe(44 + 6)
  })

  it('speaks an assistant\'s cloned voice without a Hugging Face token', async () => {
    await previewVoice({ voice: { speaker: 'pocket', voice: 'clone:abcdefabcdef' } })
    expect(synthesizeWith.mock.calls[0]![0]).toMatchObject({ speaker: 'pocket', pocketVoice: 'clone:abcdefabcdef' })
  })

  it('refuses, with the reason, a voice that would fall back to the bar\'s, and the device\'s own', async () => {
    await expect(previewVoice({ voice: { speaker: 'gemini', voice: 'Puck' } })).rejects.toThrow(/No Gemini key/)
    await expect(previewVoice({ voice: { speaker: 'gemini', voice: 'Puck' } })).rejects.toBeInstanceOf(PreviewError)
    await expect(previewVoice({ agentVoice: { speaker: 'browser' } })).rejects.toThrow(/device/)
    expect(synthesizeWith).not.toHaveBeenCalled()
    geminiKey = 'key'
    await previewVoice({ voice: { speaker: 'gemini', voice: 'Puck' } })
    expect(synthesizeWith.mock.calls[0]![0]).toMatchObject({ speaker: 'gemini', geminiVoice: 'Puck' })
  })
})
