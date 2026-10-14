import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { anthropicApiKey, claudeOauthToken } from '../../server/lib/claude-credentials'
import { geminiApiKey } from '../../server/lib/gemini'
import { openAiApiKey } from '../../server/lib/openai'
import { forgetSecretSettings, rememberSecretSettings, storedSecret } from '../../server/lib/secret-settings'

const VARIABLES = [
  'NUXT_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'NUXT_OPENAI_API_KEY', 'OPENAI_API_KEY', 'NUXT_CODEX_API_KEY', 'CODEX_API_KEY',
  'NUXT_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY',
  'NUXT_CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'
]
const saved = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]))

const stored = {
  geminiApiKey: ' AIza-stored ',
  openAiApiKey: 'sk-stored',
  anthropicApiKey: 'sk-ant-stored',
  claudeCodeOauthToken: 'sk-ant-oat-stored',
  openCodeApiKey: ''
}

beforeEach(() => {
  for (const name of VARIABLES) Reflect.deleteProperty(process.env, name)
})
afterEach(() => {
  forgetSecretSettings()
  for (const name of VARIABLES) {
    if (saved[name] === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = saved[name]
  }
})

describe('credentials stored in Settings', () => {
  it('are what every reader answers when the environment has none', () => {
    rememberSecretSettings(stored)
    expect(geminiApiKey()).toBe('AIza-stored')
    expect(openAiApiKey()).toBe('sk-stored')
    expect(anthropicApiKey()).toBe('sk-ant-stored')
    expect(claudeOauthToken()).toBe('sk-ant-oat-stored')
    expect(storedSecret('openCodeApiKey')).toBeNull()
  })

  it('lose to the environment variable for the same purpose', () => {
    rememberSecretSettings(stored)
    process.env.NUXT_GEMINI_API_KEY = 'AIza-env'
    process.env.CODEX_API_KEY = 'sk-codex-env'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-env'
    expect(geminiApiKey()).toBe('AIza-env')
    expect(openAiApiKey()).toBe('sk-codex-env')
    expect(anthropicApiKey()).toBe('sk-ant-env')
    expect(claudeOauthToken()).toBe('sk-ant-oat-env')
  })

  it('are gone once the row is, and absent until anything was read', () => {
    expect(geminiApiKey()).toBeNull()
    rememberSecretSettings(stored)
    rememberSecretSettings({ ...stored, geminiApiKey: '' })
    expect(geminiApiKey()).toBeNull()
    expect(openAiApiKey()).toBe('sk-stored')
  })
})
