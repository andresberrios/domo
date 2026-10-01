import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'
import type { AgentVoiceServerMessage } from '../../shared/types'

/**
 * How a turn is heard, with the database, the agent and the engines stubbed:
 * which words reach the agent, and what the recogniser was told.
 */

const settings = { agentVoice: { ...DEFAULT_AGENT_VOICE } }
const deliver = vi.fn(async () => {})
const transcribe = vi.fn(async () => 'from the engine')
const synthesize = vi.fn(async () => {})

vi.mock('../../server/lib/settings', () => ({ getSettings: async () => settings }))
vi.mock('../../server/lib/acp/manager', () => ({ acpManager: { deliver, cancel: vi.fn() } }))
vi.mock('../../server/lib/repo', () => ({
  getAgentSession: async (id: string) => ({ id, cwd: '/nowhere', devEnvironmentId: null }),
  getDevEnvironment: async () => null,
  getProject: async () => null,
  listRecentUserMessages: async () => [],
  listRecentConversation: async () => [
    { type: 'agent_message', text: 'Kokoro is loaded; Moonshine is next.' },
    { type: 'user_message', text: 'Load `useAgentVoice` please' }
  ]
}))
vi.mock('../../server/lib/agent-voice/speech', async (original) => ({
  ...(await original<typeof import('../../server/lib/agent-voice/speech')>()),
  transcribe,
  synthesize
}))

const { AgentVoiceRuntime } = await import('../../server/lib/agent-voice/runtime')
const { bus } = await import('../../server/lib/bus')

/** The agent's reply streaming in, as the manager publishes it. */
function streams(agentSessionId: string, text: string, streaming = true) {
  bus.publish({
    type: 'agent-event',
    agentSessionId,
    event: { id: 'ev_reply', agentSessionId, seq: 1, type: 'agent_message', payload: { text, streaming }, createdAt: '' }
  } as any)
}

/** A second of loud noise, enough to be a segment and not silence. */
function speech(): string {
  const samples = new Int16Array(16000)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 5) * 8000)
  return Buffer.from(samples.buffer).toString('base64')
}

function delivered(): string {
  const content = (deliver.mock.calls[0] as any)?.[1]?.content as Array<{ text: string }> | undefined
  return content?.[0]?.text ?? ''
}

describe('the agent voice runtime', () => {
  beforeEach(() => {
    settings.agentVoice = { ...DEFAULT_AGENT_VOICE }
    deliver.mockClear()
    transcribe.mockClear()
  })

  it('hears a click turn with the conversation and the vocabulary as context', async () => {
    const runtime = new AgentVoiceRuntime('ag_ctx')
    runtime.addAudio(speech())
    await runtime.segmentEnd(true)
    expect(delivered()).toBe('from the engine')
    const context = (transcribe.mock.calls[0] as any)[2].context
    expect(context.conversation).toBe('Developer: Load `useAgentVoice` please\nAgent: Kokoro is loaded; Moonshine is next.')
    expect(context.vocabulary).toEqual(expect.arrayContaining(['useAgentVoice', 'Kokoro', 'Moonshine']))
    runtime.close()
  })

  it('takes the device\'s words instead of calling an engine when the device transcribes', async () => {
    settings.agentVoice.transcriber = 'browser'
    const runtime = new AgentVoiceRuntime('ag_dictation')
    const messages: AgentVoiceServerMessage[] = []
    runtime.addListener(message => messages.push(message))
    runtime.addAudio(speech())
    runtime.addDictation('switch the transcriber')
    runtime.addDictation('to Whisper')
    await runtime.segmentEnd(true)
    expect(transcribe).not.toHaveBeenCalled()
    expect(delivered()).toBe('switch the transcriber to Whisper')
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'dictation', enabled: true, language: 'en' })))
    const config = messages.find(message => message.type === 'dictation') as any
    expect(config.phrases).toEqual(expect.arrayContaining(['Kokoro']))
    runtime.close()
  })

  it('drops the device\'s words with a discarded turn, so they never join the next one', async () => {
    settings.agentVoice.transcriber = 'browser'
    const runtime = new AgentVoiceRuntime('ag_discard')
    runtime.addDictation('never mind this')
    runtime.discard()
    runtime.addAudio(speech())
    runtime.addDictation('the real turn')
    await runtime.segmentEnd(true)
    expect(delivered()).toBe('the real turn')
    runtime.close()
  })

  it('has the device say the reply, piece by piece, when the device speaks', async () => {
    settings.agentVoice.speaker = 'browser'
    const runtime = new AgentVoiceRuntime('ag_device_speaker')
    const messages: AgentVoiceServerMessage[] = []
    runtime.addListener(message => messages.push(message))
    streams('ag_device_speaker', 'It records your voice, sends it up')
    streams('ag_device_speaker', 'It records your voice, sends it up, and plays the answer. Then it waits.', false)
    await vi.waitFor(() => expect(messages.filter(m => m.type === 'say')).toHaveLength(3))
    expect(messages.filter(m => m.type === 'say').map((m: any) => m.text)).toEqual([
      'It records your voice,',
      'sends it up, and plays the answer.',
      'Then it waits.'
    ])
    expect(synthesize).not.toHaveBeenCalled()
    runtime.close()
  })

  it('tells an open bar at once when Settings switch to the device\'s recogniser', async () => {
    const runtime = new AgentVoiceRuntime('ag_switch')
    const messages: AgentVoiceServerMessage[] = []
    runtime.addListener(message => messages.push(message))
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'dictation', enabled: false })))
    settings.agentVoice.transcriber = 'browser'
    bus.publish({ type: 'settings-changed' } as any)
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({ type: 'dictation', enabled: true })))
    runtime.close()
  })
})
