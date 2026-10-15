import { describe, expect, it } from 'vitest'

import { checkModel, classifyClaude, classifyCodex, classifyOpenCode, explainCheckFailure, heardRight, voiceProblem } from '../../server/lib/setup'
import { forgetSecretSettings, rememberSecretSettings } from '../../server/lib/secret-settings'
import { DEFAULT_AGENT_VOICE } from '../../shared/agent-voice'

describe('what a coding agent signs in with', () => {
  it('puts Claude Code\'s token first and its API key last, as the adapter does', () => {
    expect(classifyClaude({ token: true, hostLogin: true, apiKey: true })).toMatchObject({ login: 'subscription', environments: true })
    // A host login cannot reach an environment: nothing copies it into one.
    expect(classifyClaude({ token: false, hostLogin: true, apiKey: true })).toMatchObject({ login: 'subscription', environments: false })
    expect(classifyClaude({ token: false, hostLogin: false, apiKey: true })).toMatchObject({ login: 'api-key' })
    expect(classifyClaude({ token: false, hostLogin: false, apiKey: false })).toMatchObject({ login: 'none' })
  })

  it('calls a key saved into Codex\'s own login what it is: API billing', () => {
    expect(classifyCodex({ login: 'chatgpt', apiKey: true }).login).toBe('subscription')
    expect(classifyCodex({ login: 'apikey', apiKey: false }).login).toBe('api-key')
    expect(classifyCodex({ login: null, apiKey: true }).login).toBe('api-key')
    expect(classifyCodex({ login: null, apiKey: false }).login).toBe('none')
  })

  it('lets OpenCode run free models with no account at all', () => {
    expect(classifyOpenCode({ key: false, hostLogin: false })).toMatchObject({ login: 'free', environments: true })
    expect(classifyOpenCode({ key: false, hostLogin: true })).toMatchObject({ login: 'subscription', environments: false })
    expect(classifyOpenCode({ key: true, hostLogin: false })).toMatchObject({ login: 'subscription', environments: true })
  })
})

describe('the live check', () => {
  it('runs on the cheap model, a free one for OpenCode without an account, and never on a default', () => {
    expect(checkModel('claude-code', ['default', 'sonnet', 'haiku'])).toBe('haiku')
    expect(checkModel('claude-code', ['default', 'sonnet'])).toBeNull()
    expect(checkModel('opencode', ['opencode/big-model', 'opencode/cat-jam-free'])).toBe('opencode/cat-jam-free')
    expect(checkModel('opencode', ['opencode-go/glm-5.3-flash', 'opencode/cat-jam-free'])).toBe('opencode-go/glm-5.3-flash')
  })

  it('says what to do when sign-in fails', () => {
    expect(explainCheckFailure('claude-code', 'Authentication required'))
      .toBe('Claude Code could not sign in: Authentication required. Run claude setup-token again and paste the new token.')
    expect(explainCheckFailure('codex', 'no answer within 90s')).toMatch(/did not answer within 90 seconds/)
    expect(explainCheckFailure('opencode', '@opencode/cli is missing from this Domo install.')).toMatch(/not installed/)
  })

  it('accepts the sentence heard back give or take a word, and nothing else', () => {
    expect(heardRight('Domo can hear you and talk back.', 'Domo can hear you and talk back')).toBe(true)
    expect(heardRight('Domo can hear you and talk back.', 'Domo can hear you, talk back!')).toBe(true)
    expect(heardRight('Domo can hear you and talk back.', 'Thank you.')).toBe(false)
    expect(heardRight('Domo can hear you and talk back.', '')).toBe(false)
  })
})

describe('voice', () => {
  it('needs the key of whichever engine is chosen, and nothing for the device\'s dictation or the open models', () => {
    forgetSecretSettings()
    const saved = process.env.NUXT_GEMINI_API_KEY
    for (const name of ['NUXT_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) Reflect.deleteProperty(process.env, name)
    try {
      expect(voiceProblem({ transcriber: 'gemini', speaker: 'local' }, DEFAULT_AGENT_VOICE)).toMatch(/Gemini/)
      expect(voiceProblem({ transcriber: 'browser', speaker: 'local' }, DEFAULT_AGENT_VOICE)).toBeNull()
      rememberSecretSettings({ geminiApiKey: 'AIza', openAiApiKey: '', anthropicApiKey: '', claudeCodeOauthToken: '', openCodeApiKey: '', copilotGithubToken: '', kyutaiApiKey: '' })
      expect(voiceProblem({ transcriber: 'gemini', speaker: 'gemini' }, DEFAULT_AGENT_VOICE)).toBeNull()
    } finally {
      forgetSecretSettings()
      if (saved !== undefined) process.env.NUXT_GEMINI_API_KEY = saved
    }
  })
})
