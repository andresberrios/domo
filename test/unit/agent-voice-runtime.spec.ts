import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'
import type { AgentVoiceServerMessage } from '../../shared/types'

/**
 * How a turn is heard, with the database, the agent and the engines stubbed:
 * which words reach the agent, and what the recogniser was told.
 */

const settings = { agentVoice: { ...DEFAULT_AGENT_VOICE } }
const deliver = vi.fn(async () => {})
const answerPermission = vi.fn(async () => true)
const transcribe = vi.fn(async () => 'from the engine')
const synthesize = vi.fn(async () => {})

vi.mock('../../server/lib/settings', () => ({ getSettings: async () => settings }))
vi.mock('../../server/lib/acp/manager', () => ({ acpManager: { deliver, answerPermission, cancel: vi.fn() } }))
vi.mock('../../server/lib/repo', () => ({
  getAgentSession: async (id: string) => ({
    id,
    title: `agent ${id}`,
    cwd: '/nowhere',
    devEnvironmentId: null,
    spawnedBy: id === 'ag_child' ? 'ag_parent' : null
  }),
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

const { AgentVoiceRuntime, agentVoiceManager } = await import('../../server/lib/agent-voice/runtime')
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

/** A permission request, as `createPermission` publishes it. */
function asks(agentSessionId: string, id = 'pm_1', resolvedAt: string | null = null) {
  bus.publish({
    type: 'permission-changed',
    agentSessionId,
    permission: {
      id,
      agentSessionId,
      toolCallId: null,
      title: 'Run the tests',
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' }
      ],
      toolCall: null,
      createdAt: '',
      resolvedAt,
      resolvedOptionId: null,
      resolvedBy: null
    }
  } as any)
}

/** A bar open on the device's speaker, and what it says. */
function openBar(runtime: InstanceType<typeof AgentVoiceRuntime>) {
  const messages: AgentVoiceServerMessage[] = []
  runtime.addListener(message => messages.push(message))
  return () => messages.filter(message => message.type === 'say').map((message: any) => message.text as string)
}

/** Say something into a bar whose transcriber is the device. */
async function speak(runtime: InstanceType<typeof AgentVoiceRuntime>, words: string) {
  runtime.addAudio(speech())
  runtime.addDictation(words)
  await runtime.segmentEnd(true)
}

function delivered(): string {
  const content = (deliver.mock.calls[0] as any)?.[1]?.content as Array<{ text: string }> | undefined
  return content?.[0]?.text ?? ''
}

describe('the agent voice runtime', () => {
  beforeEach(() => {
    settings.agentVoice = { ...DEFAULT_AGENT_VOICE }
    deliver.mockClear()
    answerPermission.mockClear()
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

  it('reads out its agent\'s permission request and takes a spoken yes as the answer', async () => {
    settings.agentVoice.speaker = 'browser'
    settings.agentVoice.transcriber = 'browser'
    const runtime = new AgentVoiceRuntime('ag_asks')
    const said = openBar(runtime)
    asks('ag_asks')
    await vi.waitFor(() => expect(said()).toEqual(['It needs permission: Run the tests. Allow it?']))
    await speak(runtime, 'Yes, please.')
    expect(answerPermission).toHaveBeenCalledWith('ag_asks', 'pm_1', 'yes', 'user')
    expect(deliver).not.toHaveBeenCalled()
    expect(said()).toContain('Allowed.')
    // Answered, so the next yes is a turn again.
    await speak(runtime, 'yes')
    expect(deliver).toHaveBeenCalledTimes(1)
    runtime.close()
  })

  it('delivers a sentence as a turn even while a request is waiting', async () => {
    settings.agentVoice.transcriber = 'browser'
    const runtime = new AgentVoiceRuntime('ag_asks_turn')
    openBar(runtime)
    asks('ag_asks_turn')
    await speak(runtime, 'why does it need to run them')
    expect(answerPermission).not.toHaveBeenCalled()
    expect(delivered()).toBe('why does it need to run them')
    runtime.close()
  })

  it('speaks for other agents on the bar used last, and wants allow or deny from them, not yes', async () => {
    settings.agentVoice.speaker = 'browser'
    settings.agentVoice.transcriber = 'browser'
    const older = agentVoiceManager.get('ag_older')
    const olderSaid = openBar(older)
    const bar = agentVoiceManager.get('ag_parent')
    const said = openBar(bar)
    asks('ag_other', 'pm_other')
    await vi.waitFor(() => expect(said()).toEqual(['agent ag_other needs permission: Run the tests. Say allow or deny.']))
    expect(olderSaid()).toEqual([])
    await speak(bar, 'yes')
    expect(answerPermission).not.toHaveBeenCalled()
    await speak(bar, 'deny it')
    expect(answerPermission).toHaveBeenCalledWith('ag_other', 'pm_other', 'no', 'user')
    // Its own child's requests are its own to handle.
    asks('ag_child', 'pm_child')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(said().join(' ')).not.toContain('agent ag_child')
    agentVoiceManager.close('ag_older')
    agentVoiceManager.close('ag_parent')
  })

  it('reads out a notification on the open bar, and clips a long one', async () => {
    settings.agentVoice.speaker = 'browser'
    const bar = agentVoiceManager.get('ag_listener')
    const said = openBar(bar)
    const long = `The migration is done. ${'Every table was checked twice and nothing was lost. '.repeat(10)}`
    expect(agentVoiceManager.announce({ id: 'nt_1', agentSessionId: 'ag_other', agentTitle: 'auth refactor', message: long } as any)).toBe(true)
    await vi.waitFor(() => expect(said()).toHaveLength(1))
    expect(said()[0]).toMatch(/^A note from auth refactor: The migration is done\..* The rest is in your notifications\.$/)
    expect(said()[0]!.length).toBeLessThan(400)
    agentVoiceManager.close('ag_listener')
    expect(agentVoiceManager.announce({ id: 'nt_2', agentSessionId: null, agentTitle: 'x', message: 'y' } as any)).toBe(false)
  })
})
