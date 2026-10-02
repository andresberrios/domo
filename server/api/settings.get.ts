import { geminiApiKey } from '../lib/gemini'
import { openAiApiKey } from '../lib/openai'
import { anthropicApiKey, claudeOauthToken } from '../lib/claude-credentials'
import { getSettings } from '../lib/settings'
import { openCodeCredentialState } from '../lib/opencode-credentials'
import { SECRET_SETTING_KEYS, type AppSettings, type AppSettingsView, type SecretSettingKey } from '../../shared/types'

export default defineEventHandler(async (): Promise<AppSettingsView> => {
  // The credentials stored in Settings must not go back out: each is reported
  // as a boolean, and this response is what the Settings page holds in memory.
  // The return type subtracts them, so putting one back would not compile.
  const secret = new Set<string>(SECRET_SETTING_KEYS)
  const settings = Object.fromEntries(
    Object.entries(await getSettings()).filter(([key]) => !secret.has(key))
  ) as Omit<AppSettings, SecretSettingKey>
  const openCode = await openCodeCredentialState()
  return {
    ...settings,
    hasGeminiKey: !!geminiApiKey(),
    hasAnthropicKey: !!anthropicApiKey(),
    hasOpenAiKey: !!openAiApiKey(),
    hasClaudeCodeToken: !!claudeOauthToken(),
    /** A console key, which is what a container session and the usage poll use. */
    hasOpenCodeKey: openCode.key,
    /** A login on this machine, which is all a host session needs and all Domo can see. */
    hasOpenCodeAuth: openCode.hostLogin
  }
})
