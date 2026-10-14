import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'

const state = vi.hoisted(() => ({ agentVoice: {} as Record<string, unknown> }))
vi.mock('../../server/lib/settings', () => ({ getSettings: async () => ({ agentVoice: state.agentVoice }) }))
const local = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../server/lib/agent-voice/local-models', () => ({ requestLocalModel: local }))
const pocket = vi.hoisted(() => vi.fn(async () => 'http://127.0.0.1:1'))
vi.mock('../../server/lib/agent-voice/pocket-speech', () => ({ warmPocket: pocket }))

const { warmAgentVoice } = await import('../../server/lib/agent-voice/warm')

beforeEach(() => {
  state.agentVoice = { ...DEFAULT_AGENT_VOICE }
  vi.clearAllMocks()
})

describe('the speech warm-up', () => {
  it('fetches only the turn model for the default, cloud engines', async () => {
    const lines: string[] = []
    await warmAgentVoice(line => lines.push(line))

    expect(local.mock.calls).toEqual([[{ op: 'turn-model' }]])
    expect(pocket).not.toHaveBeenCalled()
    expect(lines).toEqual(['[agent-voice] the turn model is ready'])
  })

  it('loads the open models and starts Pocket when Settings chose them', async () => {
    state.agentVoice = { ...DEFAULT_AGENT_VOICE, transcriber: 'local', speaker: 'pocket', pocketUrl: '', localTranscribeModel: 'onnx-community/whisper-base' }
    await warmAgentVoice(() => {})

    expect(local).toHaveBeenCalledWith({ op: 'transcriber', model: 'onnx-community/whisper-base' })
    expect(pocket).toHaveBeenCalledWith('')

    state.agentVoice = { ...DEFAULT_AGENT_VOICE, speaker: 'local', turnDetector: 'silence' }
    vi.clearAllMocks()
    await warmAgentVoice(() => {})
    expect(local.mock.calls).toEqual([[{ op: 'speaker' }]])
  })

  it('reports a download that failed and finishes the rest', async () => {
    state.agentVoice = { ...DEFAULT_AGENT_VOICE, speaker: 'pocket', pocketUrl: '' }
    pocket.mockRejectedValueOnce(new Error('uv is missing'))
    const lines: string[] = []
    await warmAgentVoice(line => lines.push(line))

    expect(lines).toContain('[agent-voice] could not fetch Pocket TTS ahead of time: uv is missing')
    expect(lines).toContain('[agent-voice] the turn model is ready')
  })
})
