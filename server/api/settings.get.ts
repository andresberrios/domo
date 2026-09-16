import { getSettings } from '../lib/settings'

export default defineEventHandler(async () => {
  const settings = await getSettings()
  return {
    ...settings,
    hasGeminiKey: !!(process.env.NUXT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    hasAnthropicKey: !!(process.env.NUXT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)
  }
})
