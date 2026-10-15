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
const synthesizeWith = vi.fn(async (_settings: any, _text: string, _onChunk: any, _signal?: AbortSignal) => {})
/** Each session's assistant voice, when it is one; `getAssistantOfSession` reads this. */
const assistantVoices = new Map<string, { speaker: string, voice: string }>()

vi.mock('../../server/lib/settings', () => ({ getSettings: async () => settings }))
// Which voice is free depends on the machine, so it is pinned: a Mac with uv,
// unless a test says otherwise.
const machine = vi.hoisted(() => ({ mac: true, uv: true }))
vi.mock('../../server/lib/agent-voice/machine', () => ({ machine: { isMac: () => machine.mac, onPath: () => machine.uv } }))
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
  getAssistantOfSession: async (id: string) => assistantVoices.has(id) ? { id: `as_${id}`, voice: assistantVoices.get(id) } : null,
  getProject: async () => null,
  listRecentUserMessages: async () => [],
  listRecentConversation: async () => [
    { type: 'agent_message', text: 'Kokoro is loaded; Moonshine is next.' },
    { type: 'user_message', text: 'Load `useAgentVoice` please' }
  ]
}))
// Smart Turn's verdict on a pause, set by a test; complete unless it says otherwise.
const turnModel = vi.hoisted(() => ({ probability: 0.9 }))
vi.mock('../../server/lib/agent-voice/local-speech', async (original) => ({
  ...(await original<typeof import('../../server/lib/agent-voice/local-speech')>()),
  endOfTurn: async () => turnModel.probability
}))
vi.mock('../../server/lib/agent-voice/speech', async (original) => ({
  ...(await original<typeof import('../../server/lib/agent-voice/speech')>()),
  transcribe,
  synthesizeWith
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

/** A bar open, and what it says. */
function openBar(runtime: InstanceType<typeof AgentVoiceRuntime>) {
  const messages: AgentVoiceServerMessage[] = []
  runtime.addListener(message => messages.push(message))
  return () => messages.filter(message => message.type === 'speaking' && message.text).map((message: any) => message.text as string)
}

/** Say something into a bar whose transcriber is the device. */
async function speak(runtime: InstanceType<typeof AgentVoiceRuntime>, words: string) {
  runtime.addAudio(speech())
  runtime.addDictation(words)
  await runtime.segmentEnd(true)
}

/** Everything a bar is sent, and what of it is the agent's voice coming out. */
function listen(runtime: InstanceType<typeof AgentVoiceRuntime>) {
  const messages: AgentVoiceServerMessage[] = []
  runtime.addListener(message => messages.push(message))
  const said = () => messages.filter(message => message.type === 'speaking' && message.text).map((message: any) => message.text as string)
  const played = () => messages.filter(message => message.type === 'audio').length
  return { messages, said, played }
}

/** A speech engine that answers each request with one chunk of audio. */
function chunked() {
  synthesizeWith.mockImplementation(async (_settings: any, _text: string, onChunk: any) => {
    onChunk({ data: 'AAAA', sampleRate: 24000 })
  })
}

function delivered(): string {
  const content = (deliver.mock.calls[0] as any)?.[1]?.content as Array<{ text: string }> | undefined
  return content?.[0]?.text ?? ''
}

describe('the agent voice runtime', () => {
  beforeEach(() => {
    Object.assign(machine, { mac: true, uv: true })
    settings.agentVoice = { ...DEFAULT_AGENT_VOICE }
    deliver.mockClear()
    answerPermission.mockClear()
    transcribe.mockClear()
    synthesizeWith.mockReset().mockImplementation(async () => {})
    assistantVoices.clear()
    turnModel.probability = 0.9
  })

  it('holds the reply while the developer is talking, and plays it in order at the click that ends their turn', async () => {
    settings.agentVoice.speaker = 'local'
    settings.agentVoice.transcriber = 'browser'
    chunked()
    const runtime = new AgentVoiceRuntime('ag_hold_click')
    const bar = listen(runtime)
    runtime.addAudio(speech())
    streams('ag_hold_click', 'Looking at the file now. It has two bugs.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalled())
    // Made, but not heard, and not shown as speaking either.
    expect(bar.played()).toBe(0)
    expect(bar.said()).toEqual([])
    expect(bar.messages.filter(message => message.type === 'status').at(-1)).toMatchObject({ speaking: false })

    runtime.addDictation('and check the tests too')
    const heard = runtime.segmentEnd(true)
    // At the click, not once the turn has been transcribed.
    expect(bar.said()).toEqual(['Looking at the file now. It has two bugs.'])
    expect(bar.played()).toBe(1)
    await heard
    expect(delivered()).toBe('and check the tests too')
    // What waited was never heard, so the new turn does not drop it.
    expect(bar.messages.map(message => message.type)).not.toContain('hushed')
    runtime.close()
  })

  it('holds speech through a hands-free turn judged unfinished, and plays it instead of a "yes?" in the pause', async () => {
    vi.useFakeTimers()
    try {
      settings.agentVoice.speaker = 'local'
      settings.agentVoice.transcriber = 'browser'
      turnModel.probability = 0.1
      chunked()
      const runtime = new AgentVoiceRuntime('ag_hold_pause')
      const bar = listen(runtime)
      runtime.addAudio(speech())
      runtime.addDictation('so the thing is')
      await runtime.segmentEnd(false)
      expect(bar.messages).toContainEqual(expect.objectContaining({ type: 'turn', complete: false }))
      // A permission request waits as well.
      asks('ag_hold_pause', 'pm_hold')
      streams('ag_hold_pause', 'Done with the migration.', false)
      await vi.waitFor(() => expect(synthesizeWith.mock.calls.map(call => call[1]).join(' ')).toBe('It needs permission: Run the tests. Allow it? Done with the migration.'))
      expect(bar.played()).toBe(0)

      await vi.advanceTimersByTimeAsync(2600)
      expect(bar.said().join(' ')).toBe('It needs permission: Run the tests. Allow it? Done with the migration.')
      expect(bar.played()).toBe(synthesizeWith.mock.calls.length)
      runtime.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds speech across a hands-free turn\'s pauses until the turn the detector ended is sent', async () => {
    settings.agentVoice.speaker = 'local'
    settings.agentVoice.transcriber = 'browser'
    turnModel.probability = 0.1
    chunked()
    const runtime = new AgentVoiceRuntime('ag_hold_turn')
    const bar = listen(runtime)
    runtime.addAudio(speech())
    runtime.addDictation('so the thing is')
    await runtime.segmentEnd(false)
    streams('ag_hold_turn', 'Done with the migration.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalled())

    turnModel.probability = 0.9
    runtime.addAudio(speech())
    runtime.addDictation('it is too slow')
    expect(bar.played()).toBe(0)
    await runtime.segmentEnd(false)
    expect(delivered()).toBe('so the thing is it is too slow')
    expect(bar.said()).toEqual(['Done with the migration.'])
    // "complete" is a guess, so it waits for the turn to be heard.
    const types = bar.messages.map(message => message.type)
    expect(types.indexOf('sent')).toBeLessThan(types.indexOf('audio'))
    runtime.close()
  })

  it('stops what was held when the turn is a "stop"', async () => {
    settings.agentVoice.speaker = 'local'
    settings.agentVoice.transcriber = 'browser'
    chunked()
    const runtime = new AgentVoiceRuntime('ag_hold_stop')
    const bar = listen(runtime)
    runtime.addAudio(speech())
    streams('ag_hold_stop', 'Here is a long answer.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalled())
    runtime.addDictation('stop')
    await runtime.segmentEnd(true)
    const types = bar.messages.map(message => message.type)
    expect(types.lastIndexOf('hushed')).toBeGreaterThan(types.lastIndexOf('audio'))
    expect(bar.messages.at(-1)).toEqual({ type: 'command', name: 'hush' })
    expect(deliver).not.toHaveBeenCalled()
    runtime.close()
  })

  it('speaks at once when nobody is talking', async () => {
    settings.agentVoice.speaker = 'local'
    chunked()
    const runtime = new AgentVoiceRuntime('ag_no_hold')
    const bar = listen(runtime)
    streams('ag_no_hold', 'Straight out.', false)
    await vi.waitFor(() => expect(bar.played()).toBe(1))
    runtime.close()
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

  it('sends what the composer has attached with the next spoken turn, once', async () => {
    const runtime = new AgentVoiceRuntime('ag_attach')
    const messages: AgentVoiceServerMessage[] = []
    runtime.addListener(message => messages.push(message))
    const shot = { type: 'resource_link', uri: 'file:///data/uploads/up_1.png', name: 'shot.png' }
    // Anything that is not a link is not an attachment, and is dropped.
    runtime.setAttachments([shot, { type: 'text', text: 'smuggled' }])

    await speak(runtime, 'what is wrong here')
    const content = (deliver.mock.calls[0] as any)[1].content
    expect(content[0]).toEqual(shot)
    expect(content.filter((block: any) => block.type === 'text').map((block: any) => block.text)[0]).toBe('from the engine')
    expect(content).not.toContainEqual({ type: 'text', text: 'smuggled' })
    // The composer lets go of it.
    expect(messages).toContainEqual({ type: 'attachments-sent', uris: [shot.uri] })

    deliver.mockClear()
    await speak(runtime, 'and now')
    expect((deliver.mock.calls[0] as any)[1].content.some((block: any) => block.type === 'resource_link')).toBe(false)
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

  it('reads the reply out as it streams, all of it, once', async () => {
    settings.agentVoice.speaker = 'local'
    const runtime = new AgentVoiceRuntime('ag_streams')
    openBar(runtime)
    streams('ag_streams', 'It records your voice, sends it up')
    streams('ag_streams', 'It records your voice, sends it up, and plays the answer. Then it waits.', false)
    await vi.waitFor(() => expect(synthesizeWith.mock.calls.map(call => call[1]).join(' ')).toBe('It records your voice, sends it up, and plays the answer. Then it waits.'))
    runtime.close()
  })

  it('speaks with a free voice when the bar\'s engine cannot speak here, and says so once', async () => {
    // The default speaker is Gemini, and the tests have no key.
    const runtime = new AgentVoiceRuntime('ag_no_key')
    const messages: AgentVoiceServerMessage[] = []
    runtime.addListener(message => messages.push(message))
    streams('ag_no_key', 'First reply.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalledTimes(1))
    expect(['mac', 'pocket', 'local']).toContain(synthesizeWith.mock.calls[0]![0].speaker)
    streams('ag_no_key', 'Second reply.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalledTimes(2))
    const notices = messages.filter(message => message.type === 'notice').map((message: any) => message.message)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/^Gemini cannot speak here \(No Gemini API key.*is reading instead\./)
    expect(messages.some(message => message.type === 'error')).toBe(false)
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
    settings.agentVoice.speaker = 'local'
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
    settings.agentVoice.speaker = 'local'
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
    settings.agentVoice.speaker = 'local'
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

  it('speaks an assistant\'s replies in its own voice, even when the bar speaks with another engine', async () => {
    settings.agentVoice.speaker = 'local'
    assistantVoices.set('ag_fox', { speaker: 'pocket', voice: 'mary' })
    const runtime = new AgentVoiceRuntime('ag_fox')
    const said = openBar(runtime)
    streams('ag_fox', 'All released. Tagged v2.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalled())
    const [used, text] = synthesizeWith.mock.calls[0]!
    expect(used).toMatchObject({ speaker: 'pocket', pocketVoice: 'mary' })
    expect(text).toBe('All released. Tagged v2.')
    expect(synthesizeWith.mock.calls.every(call => call[0].speaker === 'pocket')).toBe(true)
    expect(said()).toEqual(['All released. Tagged v2.'])
    runtime.close()
  })

  it('speaks with a cloned voice without a Hugging Face token, and says so once when it falls back to the bar\'s', async () => {
    settings.agentVoice.speaker = 'local'
    assistantVoices.set('ag_clone', { speaker: 'pocket', voice: 'clone:abcdefabcdef' })
    const token = process.env.HF_TOKEN
    delete process.env.HF_TOKEN
    synthesizeWith.mockImplementation(async (used: any) => {
      if (used.speaker === 'pocket') throw new Error('Pocket could not load the clone')
    })
    const runtime = new AgentVoiceRuntime('ag_clone')
    const messages: AgentVoiceServerMessage[] = []
    runtime.addListener(message => messages.push(message))
    streams('ag_clone', 'Here it is.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalledTimes(2))
    expect(synthesizeWith.mock.calls[0]![0]).toMatchObject({ speaker: 'pocket', pocketVoice: 'clone:abcdefabcdef' })
    expect(synthesizeWith.mock.calls[1]![0]).toMatchObject({ speaker: 'local', pocketVoice: DEFAULT_AGENT_VOICE.pocketVoice })
    expect(messages.some(message => message.type === 'error')).toBe(false)
    const notices = () => messages.filter(message => message.type === 'notice')
    expect(notices()).toEqual([{ type: 'notice', message: expect.stringContaining('Pocket could not load the clone') }])
    streams('ag_clone', 'And another thing.', false)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalledTimes(4))
    expect(notices()).toHaveLength(1)
    runtime.close()
    if (token !== undefined) process.env.HF_TOKEN = token
  })

  it('reads an assistant\'s note in its voice on another agent\'s bar', async () => {
    settings.agentVoice.speaker = 'local'
    assistantVoices.set('ag_wren', { speaker: 'local', voice: 'bf_emma' })
    const bar = agentVoiceManager.get('ag_listening')
    openBar(bar)
    agentVoiceManager.announce({ id: 'nt_3', agentSessionId: 'ag_wren', agentTitle: 'Weather Wren', message: 'Rain at noon.' } as any)
    await vi.waitFor(() => expect(synthesizeWith).toHaveBeenCalled())
    expect(synthesizeWith.mock.calls[0]![0]).toMatchObject({ speaker: 'local', localVoice: 'bf_emma' })
    agentVoiceManager.close('ag_listening')
  })
})
