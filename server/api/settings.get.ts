import { geminiApiKey } from '../lib/gemini'
import { getSettings } from '../lib/settings'
import { openCodeCredentialState } from '../lib/opencode-credentials'

export default defineEventHandler(async () => {
  // `openCodeApiKey` is the one secret stored in Settings, and it must not go
  // back out: every other credential here is reported as a boolean, and this
  // response is what the Settings page holds in memory.
  const { openCodeApiKey, ...settings } = await getSettings()
  const openCode = await openCodeCredentialState()
  return {
    ...settings,
    hasGeminiKey: !!geminiApiKey(),
    hasAnthropicKey: !!(process.env.NUXT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY),
    hasOpenAiKey: !!(
      process.env.NUXT_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.NUXT_OPENAI_API_KEY
      || process.env.OPENAI_API_KEY
    ),
    /** A console key, which is what a container session and the usage poll use. */
    hasOpenCodeKey: openCode.key,
    /** A login on this machine, which is all a host session needs and all Domo can see. */
    hasOpenCodeAuth: openCode.hostLogin
  }
})
