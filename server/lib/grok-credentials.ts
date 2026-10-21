import { secret } from './secret-settings'

/**
 * What Grok Build signs in with.
 *
 * Every session uses the computer's own `grok login` (a grok.com account),
 * which Grok keeps in `~/.grok/auth.json`. That login's refresh token is
 * single-use, so it is never copied anywhere: two holders would log each
 * other out. A **container** session borrows short-lived access tokens from
 * it through Domo instead (`acp/grok-token.ts`). Without a login, the xAI
 * API key saved in Settings signs in everywhere; it does not rotate. The key
 * bills the xAI API per token, so it is passed only when there is no login
 * (`adapterEnv`), even though Grok itself would prefer the login: a login
 * whose refresh fails for good is dropped, and Grok would then move to the
 * key without a word.
 *
 * Grok's model ids carry no provider prefix and every one is xAI's, so a
 * model id cannot land on a second account.
 */

/** The key saved in Settings (or set by the server's configuration), or null. */
export function xaiApiKey(): string | null {
  return secret('xaiApiKey')
}
