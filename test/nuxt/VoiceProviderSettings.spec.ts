import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'

import VoiceProviderSettings from '~/components/VoiceProviderSettings.vue'
import { DEFAULT_VOICE_DELEGATION } from '~~/shared/voice-providers'

/**
 * The card that chooses which live voice model runs conversations.
 *
 * Two things about it are worth a test rather than a look. The providers are
 * configured with different fields, and showing the idle one's fields would be
 * offering settings that do nothing — so what is asserted is which fields are
 * *absent*. And listing OpenAI's models costs a round trip to a second vendor,
 * which an install running Gemini must not pay: the probe is deferred until
 * the OpenAI side is actually on screen, the same rule the agent composer's
 * model picker follows.
 */

const geminiCalls: number[] = []
const openAiCalls: number[] = []

registerEndpoint('/api/models', () => {
  geminiCalls.push(Date.now())
  return { models: [{ name: 'gemini-3.8-live', live: true }, { name: 'gemini-flash-lite', live: false }] }
})

registerEndpoint('/api/openai-models', () => {
  openAiCalls.push(Date.now())
  return { models: [{ id: 'gpt-live-1', live: true }, { id: 'gpt-5.6-sol', live: false }] }
})

mockNuxtImport('useAgentSessions', () => () => ({
  sessions: computed(() => [{ id: 'as_1', title: 'invoice tests' }]),
  all: computed(() => []),
  isReady: computed(() => true)
}))

mockNuxtImport('useDevEnvironments', () => () => ({
  environments: computed(() => [{ id: 'de_1', name: 'domo', retiredAt: null }]),
  all: computed(() => []),
  isReady: computed(() => true)
}))

function form(overrides: Record<string, unknown> = {}) {
  return reactive({
    voiceProvider: 'gemini',
    liveModel: 'gemini-3.8-live',
    voiceName: 'Puck',
    language: 'en-US',
    openaiLiveModel: 'gpt-live-1',
    openaiVoiceName: 'marin',
    openaiDelegation: { ...DEFAULT_VOICE_DELEGATION },
    ...overrides
  })
}

async function mount(state: any) {
  return mountSuspended(VoiceProviderSettings, {
    props: { modelValue: state, 'onUpdate:modelValue': () => {} },
    attachTo: document.body
  })
}

beforeEach(() => {
  geminiCalls.length = 0
  openAiCalls.length = 0
  document.body.innerHTML = ''
})

describe('choosing a voice provider', () => {
  it('offers both, and says what the difference is', async () => {
    const wrapper = await mount(form())

    expect(wrapper.text()).toContain('Gemini Live')
    expect(wrapper.text()).toContain('GPT-Live')
    expect(wrapper.text()).toContain('delegates the thinking')
  })

  it('marks the chosen one, and changes the form when the other is clicked', async () => {
    const state = form()
    const wrapper = await mount(state)

    const gpt = wrapper.findAll('button').find(button => button.text().includes('GPT-Live'))!
    expect(gpt.attributes('aria-pressed')).toBe('false')

    await gpt.trigger('click')

    expect(state.voiceProvider).toBe('openai')
  })
})

describe('only the chosen provider\'s fields', () => {
  it('shows the spoken language on Gemini, which is a Gemini setting', async () => {
    const wrapper = await mount(form())

    expect(wrapper.text()).toContain('Spoken language')
    expect(wrapper.text()).not.toContain('Thinking')
  })

  it('shows the delegation choice on GPT-Live, and not the language', async () => {
    const wrapper = await mount(form({ voiceProvider: 'openai' }))

    expect(wrapper.text()).toContain('An OpenAI model')
    expect(wrapper.text()).toContain('A coding agent session')
    // Gemini's, and there is no equivalent: GPT-Live takes no language field.
    expect(wrapper.text()).not.toContain('Spoken language')
  })

  it('asks for the backend model only when a model is what thinks', async () => {
    const wrapper = await mount(form({
      voiceProvider: 'openai',
      openaiDelegation: { ...DEFAULT_VOICE_DELEGATION, target: 'agent' }
    }))

    expect(wrapper.text()).toContain('Thinking agent')
    expect(wrapper.text()).not.toContain('Reasoning effort')
    // And it says plainly what this mode gives up, because nothing else will.
    expect(wrapper.text()).toContain('What this mode cannot do')
  })

  it('offers the adapter and environment only for a session it has to create', async () => {
    const chosen = await mount(form({
      voiceProvider: 'openai',
      openaiDelegation: { ...DEFAULT_VOICE_DELEGATION, target: 'agent', agentSessionId: 'as_1' }
    }))
    expect(chosen.text()).not.toContain('Development environment')

    const automatic = await mount(form({
      voiceProvider: 'openai',
      openaiDelegation: { ...DEFAULT_VOICE_DELEGATION, target: 'agent' }
    }))
    expect(automatic.text()).toContain('Development environment')
  })
})

describe('listing models', () => {
  it('does not ask OpenAI anything while Gemini is the provider', async () => {
    await mount(form())
    await vi.waitFor(() => expect(geminiCalls).toHaveLength(1))

    expect(openAiCalls).toEqual([])
  })

  it('asks once the OpenAI side is on screen', async () => {
    await mount(form({ voiceProvider: 'openai' }))

    await vi.waitFor(() => expect(openAiCalls).toHaveLength(1))
  })
})
