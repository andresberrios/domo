import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_AGENT_VOICE, SPOKEN_NOTE_PREFIX } from '../../shared/agent-voice'
import {
  combineVocabulary,
  conversationPrompt,
  instructionPrompt,
  precedingTextPrompt,
  termsFromPaths,
  termsFromText
} from '../../server/lib/agent-voice/context'
import { looksHallucinated, transcribeWith } from '../../server/lib/agent-voice/speech'
import { whisperWindows } from '../../server/lib/agent-voice/local-speech'

/**
 * What a recogniser is told before it hears a turn. The failure these pin is
 * quiet: a vocabulary full of English words or environment variables, or a
 * prompt that drops the conversation, still transcribes, just worse.
 */

describe('termsFromText', () => {
  it('keeps identifiers, code spans and mid-sentence names', () => {
    const terms = termsFromText('Open `useAgentVoice` and the AgentVoiceBar. Then run pnpm through Nuxt and check agent_sessions in `repo.ts`.')
    expect([...terms.keys()]).toEqual(expect.arrayContaining(['useAgentVoice', 'AgentVoiceBar', 'Nuxt', 'agent_sessions', 'repo']))
  })

  it('drops sentence-initial capitals, English words used as prose, hashes and environment variables', () => {
    const terms = termsFromText('Then the server restarts. The `server` flag and NUXT_GEMINI_API_KEY and 1a2b3c4d5e6f are set.')
    expect(terms.has('Then')).toBe(false)
    expect(terms.has('server')).toBe(false)
    expect(terms.has('NUXT_GEMINI_API_KEY')).toBe(false)
    expect(terms.has('1a2b3c4d5e6f')).toBe(false)
  })
})

describe('termsFromPaths', () => {
  it('names components and modules by their file names, not their folders of English', () => {
    const terms = termsFromPaths(['app/components/AgentVoiceBar.vue', 'server/lib/agent-voice/runtime.ts', 'docs/voice.md'])
    expect([...terms.keys()]).toEqual(expect.arrayContaining(['AgentVoiceBar', 'agent-voice']))
    expect(terms.has('runtime')).toBe(false)
    expect(terms.has('docs')).toBe(false)
  })
})

describe('conversationPrompt', () => {
  it('is the newest messages, oldest first, without the spoken note or tool calls', () => {
    const prompt = conversationPrompt([
      { type: 'agent_message', text: 'Kokoro is loaded.' },
      { type: 'tool_call', text: 'Read runtime.ts' },
      { type: 'user_message', text: `Switch to Kokoro\n${SPOKEN_NOTE_PREFIX} say it out loud` }
    ])
    expect(prompt).toBe('Developer: Switch to Kokoro\nAgent: Kokoro is loaded.')
  })

  it('keeps the end of a long message, which is what the next turn answers', () => {
    const prompt = conversationPrompt([{ type: 'agent_message', text: `${'a '.repeat(400)}Should I restart Nitro?` }])
    expect(prompt.endsWith('Should I restart Nitro?')).toBe(true)
    expect(prompt.length).toBeLessThan(400)
  })
})

describe('combineVocabulary', () => {
  it('puts the conversation first, then the project, once each whatever the case', () => {
    const vocabulary = combineVocabulary(
      [{ type: 'user_message', text: 'Look at `useAgentVoice`.' }, { type: 'tool_call', text: 'Read app/components/AgentVoiceBar.vue' }],
      ['Nuxt', 'useagentvoice', 'Electric']
    )
    expect(vocabulary).toEqual(['useAgentVoice', 'AgentVoiceBar', 'Nuxt', 'Electric'])
  })
})

describe('prompts', () => {
  const context = { conversation: 'Developer: switch to Kokoro\nAgent: Done, Kokoro speaks now.', vocabulary: ['Kokoro', 'Moonshine'] }

  it('tells an instruction-following recogniser the terms and the conversation', () => {
    const prompt = instructionPrompt(context)
    expect(prompt).toContain('Kokoro, Moonshine')
    expect(prompt).toContain('Agent: Done, Kokoro speaks now.')
  })

  it('gives Whisper preceding text that ends with the latest words, within its budget', () => {
    const prompt = precedingTextPrompt({ ...context, conversation: `Agent: ${'x'.repeat(2000)} Kokoro speaks now.` }, 300)
    expect(prompt.startsWith('Glossary: Kokoro, Moonshine.')).toBe(true)
    expect(prompt.endsWith('Kokoro speaks now.')).toBe(true)
    expect(prompt.length).toBeLessThanOrEqual(300)
  })

  it('is empty with nothing to say, so no prompt is sent', () => {
    expect(instructionPrompt({ conversation: '', vocabulary: [] })).toBe('')
    expect(precedingTextPrompt({ conversation: '', vocabulary: [] })).toBe('')
  })
})

describe('the OpenAI transcriber', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  async function formSent(settings: Partial<typeof DEFAULT_AGENT_VOICE>, context?: { conversation: string, vocabulary: string[] }) {
    vi.stubEnv('NUXT_OPENAI_API_KEY', 'sk-test')
    vi.stubEnv('NUXT_OPENAI_API_BASE', 'http://openai.test/v1')
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: ' heard ' })))
    vi.stubGlobal('fetch', fetch)
    const text = await transcribeWith({ ...DEFAULT_AGENT_VOICE, transcriber: 'openai', ...settings }, new Int16Array(1600), 16000, { context })
    expect(text).toBe('heard')
    return (fetch.mock.calls[0] as any)[1].body as FormData
  }

  it('sends the language and the context as its prompt', async () => {
    const form = await formSent({ language: 'en' }, { conversation: 'Agent: Kokoro is loaded.', vocabulary: ['Kokoro'] })
    expect(form.get('language')).toBe('en')
    expect(String(form.get('prompt'))).toContain('Kokoro is loaded.')
  })

  it('lets the model guess the language only when told to, and sends no empty prompt', async () => {
    const form = await formSent({ language: '' })
    expect(form.has('language')).toBe(false)
    expect(form.has('prompt')).toBe(false)
  })
})

describe('looksHallucinated', () => {
  it('catches a loop and a flood of words, and passes ordinary speech', () => {
    expect(looksHallucinated('YEAH YEAH YEAH YEAH YEAH YEAH YEAH YEAH YEAH', 3)).toBe(true)
    expect(looksHallucinated('go on and on go on and on go on and on go on and on go on and on', 10)).toBe(true)
    expect(looksHallucinated('word '.repeat(80), 4)).toBe(true)
    expect(looksHallucinated('Yeah, yeah, I think that works. Run pnpm test and then merge main.', 5)).toBe(false)
    // A real speaker, from Earnings-22.
    expect(looksHallucinated('we could get the uh the the the the the PPAs correspondingly attractive', 8)).toBe(false)
  })
})

describe('a primed transcription that fails', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('is heard again without the context', async () => {
    vi.stubEnv('NUXT_OPENAI_API_KEY', 'sk-test')
    const answers = ['YEAH YEAH YEAH YEAH YEAH YEAH YEAH YEAH YEAH', 'I guess that is it']
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: answers.shift() })))
    vi.stubGlobal('fetch', fetch)
    const text = await transcribeWith(
      { ...DEFAULT_AGENT_VOICE, transcriber: 'openai' },
      new Int16Array(32000),
      16000,
      { context: { conversation: 'Developer: yeah.', vocabulary: [] } }
    )
    expect(text).toBe('I guess that is it')
    expect(((fetch.mock.calls[1] as any)[1].body as FormData).has('prompt')).toBe(false)
  })
})

describe('whisperWindows', () => {
  it('cuts a long turn into windows Whisper hears whole, in the pauses, losing nothing', () => {
    const rate = 16000
    const floats = new Float32Array(70 * rate)
    for (let i = 0; i < floats.length; i++) floats[i] = Math.sin(i / 7) * 0.3
    // Pauses at 22 s and 47 s, where a speaker breathes.
    for (const pause of [22, 47]) floats.fill(0, pause * rate, (pause + 0.4) * rate)
    const windows = whisperWindows(floats, rate)
    expect(windows.map(window => Math.round(window.length / rate))).toEqual([22, 25, 23])
    expect(windows.every(window => window.length <= 28 * rate)).toBe(true)
    expect(windows.reduce((sum, window) => sum + window.length, 0)).toBe(floats.length)
  })

  it('leaves a turn under the limit alone', () => {
    expect(whisperWindows(new Float32Array(10 * 16000), 16000)).toHaveLength(1)
  })
})
