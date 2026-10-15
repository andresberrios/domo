import { secret } from './secret-settings'

/** The Gemini key: the server's override first, then the one stored in Settings. */
export function geminiApiKey(): string | null {
  return secret('geminiApiKey')
}
