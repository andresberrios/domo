import { geminiApiKey } from '../lib/gemini'
import { getSettings } from '../lib/settings'

export default defineEventHandler(async () => {
  const settings = await getSettings()
  return {
    ...settings,
    hasGeminiKey: !!geminiApiKey(),
    hasAnthropicKey: !!(process.env.NUXT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY),
    hasOpenAiKey: !!(
      process.env.NUXT_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.NUXT_OPENAI_API_KEY
      || process.env.OPENAI_API_KEY
    )
  }
})
