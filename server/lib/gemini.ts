import { storedSecret } from './secret-settings'

/** The Gemini key: the environment first, then the one stored in Settings. */
export function geminiApiKey(): string | null {
  return process.env.NUXT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    || storedSecret('geminiApiKey')
}
