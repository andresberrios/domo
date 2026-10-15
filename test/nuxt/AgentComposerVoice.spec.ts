import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { enableAutoUnmount } from '@vue/test-utils'
import { computed, defineComponent, h, ref } from 'vue'
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
    expect(options.attachments.value).toEqual([
      expect.objectContaining({ type: 'resource_link', uri: 'file:///data/uploads/up_1.png' })
    ])

    options.onAttachmentsSent(['file:///data/uploads/up_1.png'])
    await vi.waitFor(() => expect(component.text()).not.toContain('shot.png'))
  })
})
