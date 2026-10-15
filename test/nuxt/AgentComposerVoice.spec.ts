import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { enableAutoUnmount } from '@vue/test-utils'
import { computed, defineComponent, h, ref, toValue } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AgentComposer from '~/components/AgentComposer.vue'
import type { AgentDraft, AgentSession } from '~~/shared/types'

/**
 * The composer's two modes. Voice mode puts the voice bar where the text box
 * is and keeps the rest of the composer; going back finds the typed text where
 * it was. The microphone, socket and speaker are `useAgentVoice`'s, which is
 * replaced here by a recorder of what the composer asked of it.
 */
const voiceCalls = vi.fn()
const voiceOptions: any[] = []
let voiceStatus: AgentSession['status'] = 'idle'

function fakeVoice() {
  const voice = {
    state: ref('live'),
    mode: ref<'click' | 'handsfree'>('click'),
    speakEnabled: ref(true),
    micEnabled: ref(false),
    captureSuspended: ref(false),
    recording: ref(false),
    transcribing: ref(false),
    synthesizing: ref(false),
    speaking: ref(false),
    inputLevel: ref(0),
    outputLevel: ref(0),
    utterance: ref(''),
    lastSent: ref(''),
    spokenText: ref<string | null>(null),
    lastCommand: ref<string | null>(null),
    notice: ref<string | null>(null),
    holding: ref(false),
    dictation: ref(false),
    errorMessage: ref<string | null>(null),
    connect: () => voiceCalls('connect'),
    start: async () => voiceCalls('start'),
    stop: () => voiceCalls('stop'),
    toggleRecording: async () => voiceCalls('toggleRecording'),
    setMode: (mode: 'click' | 'handsfree') => { voice.mode.value = mode; voiceCalls('setMode', mode) },
    setSpeak: (enabled: boolean) => voiceCalls('setSpeak', enabled),
    unlock: async () => voiceCalls('unlock'),
    expectReply: () => voiceCalls('expectReply'),
    hush: () => voiceCalls('hush'),
    cancel: () => voiceCalls('cancel'),
    sendHeld: () => voiceCalls('sendHeld'),
    discardHeld: () => voiceCalls('discardHeld'),
    replay: async (text: string) => voiceCalls('replay', text)
  }
  return voice
}

mockNuxtImport('useAgentVoice', () => (id: any, options: any) => {
  voiceCalls('create', typeof id === 'function' ? id() : id)
  voiceOptions.push(options)
  return fakeVoice()
})
mockNuxtImport('useSettings', () => () => ({ data: computed(() => ({ agentVoice: {} })), refresh: async () => {} }))

registerEndpoint('/api/agents/ag_voice/prompt', { method: 'POST', handler: () => ({ delivery: 'steer', outcome: 'prompted' }) })

registerEndpoint('/api/uploads', {
  method: 'POST',
  handler: () => ({ files: [{ name: 'shot.png', path: '/data/uploads/up_1.png', mimeType: 'image/png', size: 12 }] })
})

enableAutoUnmount(afterEach)

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'ag_voice',
    adapter: 'claude-code',
    acpSessionId: 'acp_1',
    title: 'Talking',
    cwd: '/workspaces/some/deep/project',
    devEnvironmentId: null,
    status: voiceStatus,
    modeId: null,
    modes: null,
    model: null,
    config: null,
    configOptions: null,
    steering: null,
    lastError: null,
    summary: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    archived: false,
    usage: { context: { used: 42_000, size: 200_000 }, updatedAt: '2026-01-01T00:00:00.000Z' },
    spawnedBy: null,
    assistantId: null,
    ...overrides
  }
}

const Harness = defineComponent({
  props: {
    session: { type: Object as () => AgentSession | null, default: null },
    draft: { type: Object as () => AgentDraft | null, default: null }
  },
  setup: props => () => h(UApp, null, {
    default: () => h(AgentComposer, { session: props.session, draft: props.draft })
  })
})

const mount = (props: Record<string, unknown>) => mountSuspended(Harness, { props })
const button = (component: any, label: string) => component.find(`button[aria-label="${label}"]`)

beforeEach(() => {
  voiceCalls.mockClear()
  voiceOptions.length = 0
  voiceStatus = 'idle'
  useAgentVoiceOpen().value = false
  useAgentVoiceListen().value = false
  localStorage.clear()
})

describe('AgentComposer modes', () => {
  it('leaves the working directory to the page header, and shows the context gauge instead', async () => {
    const component = await mount({ session: session() })

    expect(component.text()).not.toContain('project')
    expect(button(component, 'Context window: 21%').exists()).toBe(true)
  })

  it('swaps the text box for the voice bar, and back with the typed text intact', async () => {
    const component = await mount({ session: session() })
    await component.find('textarea').setValue('half a thought')

    await button(component, 'Talk instead').trigger('click')

    expect(component.find('textarea').exists()).toBe(false)
    expect(component.find('[data-testid="voice-bar"]').exists()).toBe(true)
    expect(voiceCalls).toHaveBeenCalledWith('create', 'ag_voice')
    // The socket only: a microphone opened outside a tap stays suspended on iOS.
    expect(voiceCalls).toHaveBeenCalledWith('connect')
    expect(voiceCalls).not.toHaveBeenCalledWith('start')
    // The rest of the composer stays.
    expect(button(component, 'Context window: 21%').exists()).toBe(true)
    expect(component.text()).toContain('Claude Code')

    await button(component, 'Type instead').trigger('click')

    expect(component.find('[data-testid="voice-bar"]').exists()).toBe(false)
    expect((component.find('textarea').element as HTMLTextAreaElement).value).toBe('half a thought')
    expect(useAgentVoiceOpen().value).toBe(false)
  })

  /**
   * Hearing the agent is not talking to it: typing with the speaker on keeps
   * the text box, and still has the socket that reads replies and plays sounds.
   */
  it('hears the agent while typing when the speaker is on, and closes the voice when it is off', async () => {
    const component = await mount({ session: session() })
    expect(voiceCalls).not.toHaveBeenCalledWith('create', 'ag_voice')

    await button(component, 'Hear the agent').trigger('click')

    expect(useAgentVoiceListen().value).toBe(true)
    expect(component.find('textarea').exists()).toBe(true)
    expect(component.find('[data-testid="voice-bar"]').exists()).toBe(false)
    expect(voiceCalls).toHaveBeenCalledWith('create', 'ag_voice')
    expect(voiceCalls).toHaveBeenCalledWith('connect')
    // The tap is what lets the browser start the audio.
    await vi.waitFor(() => expect(voiceCalls).toHaveBeenCalledWith('unlock'))

    await button(component, 'Mute the agent').trigger('click')
    expect(useAgentVoiceListen().value).toBe(false)
    expect(button(component, 'Hear the agent').exists()).toBe(true)
  })

  it('turns hearing on with voice mode, and keeps it, and the voice, when going back to typing', async () => {
    const component = await mount({ session: session() })

    await button(component, 'Talk instead').trigger('click')
    expect(useAgentVoiceListen().value).toBe(true)
    // The speaker is in the footer in voice mode too, and can mute it there.
    expect(button(component, 'Mute the agent').exists()).toBe(true)

    voiceCalls.mockClear()
    await button(component, 'Type instead').trigger('click')
    // Same voice, no reconnect: only the input changed.
    expect(voiceCalls).not.toHaveBeenCalledWith('create', 'ag_voice')
    expect(button(component, 'Mute the agent').exists()).toBe(true)
  })

  it('plays the working blip for a typed message while it is heard', async () => {
    useAgentVoiceListen().value = true
    const component = await mount({ session: session() })

    await component.find('textarea').setValue('go on')
    await component.find('textarea').trigger('keydown', { key: 'Enter' })

    await vi.waitFor(() => expect(voiceCalls).toHaveBeenCalledWith('expectReply'))
  })

  it('opens in voice mode when it was left in voice mode', async () => {
    useAgentVoiceOpen().value = true
    const component = await mount({ session: session() })

    expect(component.find('[data-testid="voice-bar"]').exists()).toBe(true)
  })

  it('offers no voice mode on a draft, which has no session to talk to', async () => {
    useAgentVoiceOpen().value = true
    const draft: AgentDraft = { adapter: 'claude-code', model: '', modeId: '', config: {}, projectId: null, devEnvironmentId: null, cwd: '/tmp', title: '' }
    const component = await mount({ session: null, draft })

    expect(component.find('textarea').exists()).toBe(true)
    expect(button(component, 'Talk instead').exists()).toBe(false)
    expect(voiceCalls).not.toHaveBeenCalled()
  })

  it('cancels a turn from voice mode, including one waiting on a permission', async () => {
    voiceStatus = 'awaiting-permission'
    useAgentVoiceOpen().value = true
    const component = await mount({ session: session() })

    await button(component, 'Cancel the turn').trigger('click')

    expect(voiceCalls).toHaveBeenCalledWith('cancel')
  })

  it('switches between tap-to-talk and hands-free from the footer', async () => {
    useAgentVoiceOpen().value = true
    const component = await mount({ session: session() })

    await button(component, 'Hands-free').trigger('click')

    expect(voiceCalls).toHaveBeenCalledWith('setMode', 'handsfree')
  })

  it('hands its attachments to the spoken turn, and lets go of the ones that went', async () => {
    useAgentVoiceOpen().value = true
    const component = await mount({ session: session() })
    const input = component.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })] })
    await input.trigger('change')
    await vi.waitFor(() => expect(component.text()).toContain('shot.png'))

    const options = voiceOptions.at(-1)
    expect(toValue(options.attachments)).toEqual([
      expect.objectContaining({ type: 'resource_link', uri: 'file:///data/uploads/up_1.png' })
    ])

    options.onAttachmentsSent(['file:///data/uploads/up_1.png'])
    await vi.waitFor(() => expect(component.text()).not.toContain('shot.png'))
  })
})
