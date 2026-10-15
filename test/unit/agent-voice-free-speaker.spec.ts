import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'

// The machine is what decides, so each case pins it rather than reading this one.
const machine = vi.hoisted(() => ({ mac: false, uv: false }))
vi.mock('../../server/lib/agent-voice/machine', () => ({ machine: { isMac: () => machine.mac, onPath: () => machine.uv } }))
vi.mock('../../server/lib/gemini', () => ({ geminiApiKey: () => null }))
vi.mock('../../server/lib/openai', () => ({ openAiApiKey: () => null }))

const { barSpeech, freeSpeaker } = await import('../../server/lib/agent-voice/assistant-voice')

describe('the free voice', () => {
  it('is Apple\'s on a Mac, whatever else it has', () => {
    Object.assign(machine, { mac: true, uv: true })
    expect(freeSpeaker(DEFAULT_AGENT_VOICE)).toBe('mac')
  })

  it('is Pocket elsewhere when uv is there to start it, or a Pocket server is set', () => {
    Object.assign(machine, { mac: false, uv: true })
    expect(freeSpeaker(DEFAULT_AGENT_VOICE)).toBe('pocket')
    Object.assign(machine, { mac: false, uv: false })
    expect(freeSpeaker({ ...DEFAULT_AGENT_VOICE, pocketUrl: 'http://127.0.0.1:8000' })).toBe('pocket')
  })

  it('is Kokoro with neither', () => {
    Object.assign(machine, { mac: false, uv: false })
    expect(freeSpeaker(DEFAULT_AGENT_VOICE)).toBe('local')
  })

  it('reads in place of a bar speaker that has no key here, and says so', () => {
    Object.assign(machine, { mac: false, uv: false })
    const { settings, substitute } = barSpeech({ ...DEFAULT_AGENT_VOICE, speaker: 'gemini' })
    expect(settings.speaker).toBe('local')
    expect(substitute).toMatch(/cannot speak here \(No Gemini API key/)
  })
})
