/**
 * The OpenAI key and API base, for the voice bar's speech engines.
 *
 * Like `gemini.ts` beside it, the key is read from the environment first and
 * then from Settings (`secret-settings.ts`), which is never streamed to the
 * browser.
 */
import { storedSecret } from './secret-settings'

/**
 * The OpenAI key, in the order a self-hosted install is likely to have set one.
 *
 * `CODEX_API_KEY` is accepted last because it is the same platform credential
 * under another name — an install that configured Codex has one and should not
 * have to duplicate it — but an explicitly OpenAI-named variable wins, so an
 * operator who keeps the two apart gets the one they meant.
 */
export function openAiApiKey(): string | null {
  return process.env.NUXT_OPENAI_API_KEY
    || process.env.OPENAI_API_KEY
    || process.env.NUXT_CODEX_API_KEY
    || process.env.CODEX_API_KEY
    || storedSecret('openAiApiKey')
}

/**
 * Where the REST API lives, so a test can point it somewhere unreachable the
 * same way `NUXT_ANTHROPIC_API_BASE` already does for the usage poller.
 */
export function openAiApiBase(): string {
  return (process.env.NUXT_OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '')
}
