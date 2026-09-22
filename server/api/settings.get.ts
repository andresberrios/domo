import { geminiApiKey } from '../lib/gemini'
import { getSettings } from '../lib/settings'
import { opencodeAuthContent } from '../lib/acp/adapter-process'

export default defineEventHandler(async () => {
  const settings = await getSettings()
  const openCodeAuth = await opencodeAuthContent()
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
    hasOpenCodeAuth: !!openCodeAuth
  }
})
