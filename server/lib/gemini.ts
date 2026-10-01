/** The Gemini key only ever comes from the environment, never the database. */
export function geminiApiKey(): string | null {
  return process.env.NUXT_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || null
}
