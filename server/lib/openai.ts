/**
 * The OpenAI key and API base, for the voice bar's speech engines.
 *
 * Like `gemini.ts` beside it, the key is read from the environment first and
 * then from Settings (`secret-settings.ts`), which is never streamed to the
 * browser.
 */
import { secret } from './secret-settings'

/** The OpenAI key, in the order `SECRET_ENV` gives, then the one stored in Settings. */
export function openAiApiKey(): string | null {
  return secret('openAiApiKey')
}

/**
 * Where the REST API lives, so a test can point it somewhere unreachable the
 * same way `NUXT_ANTHROPIC_API_BASE` already does for the usage poller.
 */
export function openAiApiBase(): string {
  return (process.env.NUXT_OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '')
}
